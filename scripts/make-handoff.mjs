#!/usr/bin/env node
// Builds ./claude-context/ : a small folder you drag into a new Claude chat.
//
//   npm run handoff                       -> standard pack
//   npm run handoff -- src/rooms/RoomScreen.jsx rooms/src/room.js
//                                         -> standard pack + those files in 05-extra.md
//
// The folder is gitignored and rebuilt from scratch on every run.
// Nothing here touches the network, Supabase, or any env file.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'claude-context');
const WARN_TOKENS = 60_000;

const read = (rel) => {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, 'utf8').trimEnd() : null;
};

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
  } catch {
    return null;
  }
};

// ---- safety: never ship secrets or env files to a chat -------------------
const BLOCKED_PATH = [
  /(^|\/)\.env(?!\.example$)(\.|$)/i,
  /(^|\/)blocked-terms\.txt$/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /(^|\/)claude-context\//,
  /(^|\/)repomix-output/i,
];
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz)$/i;
const SECRET_CONTENT = [
  [/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/, 'a JWT-looking token'],
  [/sb_secret_[A-Za-z0-9_-]{10,}/, 'a Supabase secret key'],
  [/SERVICE_ROLE[A-Z_]*\s*[=:]\s*['"]?[A-Za-z0-9._-]{20,}/i, 'a service-role key assignment'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
];

function assertNoSecrets(label, text) {
  for (const [re, what] of SECRET_CONTENT) {
    if (re.test(text)) {
      console.error(`\nREFUSING to write the pack: ${label} contains ${what}.`);
      console.error('Remove it from the source file (and rotate it if it was ever committed), then re-run.');
      process.exit(1);
    }
  }
}

const section = (rel) => {
  const body = read(rel);
  return `\n\n=== FILE: ${rel} ===\n\n${body ?? '(missing: this file does not exist in the repo)'}\n`;
};

// ---- 01-state.md ----------------------------------------------------------
function buildState() {
  const lines = [`# Repo state (generated ${new Date().toISOString()})`, ''];
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === null) {
    lines.push('Git is not available here, so there is no branch/commit info.');
    return lines.join('\n') + '\n';
  }

  lines.push(`Current branch: \`${branch}\``);
  lines.push('', '## Recent commits', '```', git('log', '-10', '--format=%h %ad %s%d', '--date=short') ?? '', '```');

  const status = (git('status', '--short') ?? '').split('\n').filter(Boolean);
  lines.push('', `## Uncommitted changes (${status.length})`);
  lines.push(status.length ? '```\n' + status.slice(0, 40).join('\n') + (status.length > 40 ? `\n... and ${status.length - 40} more` : '') + '\n```' : 'Working tree is clean.');

  const base = ['main', 'master'].find((b) => git('rev-parse', '--verify', '--quiet', b) !== null);
  if (base && base !== branch) {
    lines.push('', `## This branch vs \`${base}\``);
    const counts = git('rev-list', '--left-right', '--count', `${base}...HEAD`);
    if (counts) {
      const [behind, ahead] = counts.split(/\s+/);
      lines.push(`${ahead} commit(s) ahead, ${behind} behind.`);
    }
    const stat = git('diff', '--stat', `${base}...HEAD`);
    if (stat) lines.push('```\n' + stat.split('\n').slice(-25).join('\n') + '\n```');
  }

  const branches = git('for-each-ref', '--sort=-committerdate', '--count=12', '--format=%(refname:short)  (%(committerdate:short))', 'refs/heads');
  if (branches) lines.push('', '## Local branches (newest first)', '```', branches, '```');

  const migrations = (git('ls-files', 'supabase/migrations') ?? '').split('\n').filter(Boolean).slice(-5);
  if (migrations.length) lines.push('', '## Latest migrations', ...migrations.map((m) => `- ${m.split('/').pop()}`));

  // Staleness check for the handoff report.
  const headTs = Number(git('log', '-1', '--format=%ct') ?? 0);
  let handoffTs = Number(git('log', '-1', '--format=%ct', '--', 'docs/HANDOFF.md') ?? 0);
  const handoffPath = join(root, 'docs/HANDOFF.md');
  if (!handoffTs && existsSync(handoffPath)) handoffTs = Math.floor(statSync(handoffPath).mtimeMs / 1000);
  lines.push('', '## Handoff freshness');
  if (!existsSync(handoffPath)) lines.push('`docs/HANDOFF.md` does not exist.');
  else if (handoffTs && headTs && handoffTs < headTs - 60) lines.push('WARNING: `docs/HANDOFF.md` is older than the latest commit. It may not describe the current state.');
  else lines.push('`docs/HANDOFF.md` is current as of the latest commit.');

  return lines.join('\n') + '\n';
}

// ---- 05-extra.md ----------------------------------------------------------
function buildExtra(args) {
  if (!args.length) return null;
  let out = '# Extra files requested for this chat\n';
  const realRoot = realpathSync(root);
  for (const arg of args) {
    const abs = resolve(root, arg);
    const rel = relative(root, abs).split(sep).join('/');
    if (rel.startsWith('..')) { console.error(`Skipping ${arg}: outside the repo.`); continue; }
    if (BLOCKED_PATH.some((re) => re.test(rel))) { console.error(`Skipping ${rel}: blocked (env/secret/generated file).`); continue; }
    if (BINARY_EXT.test(rel)) { console.error(`Skipping ${rel}: binary file.`); continue; }
    if (!existsSync(abs) || !statSync(abs).isFile()) { console.error(`Skipping ${rel}: not a file.`); continue; }

    // Check the resolved target too: a harmless-looking in-repo symlink must
    // not smuggle an env file or a path outside the repository into the pack.
    const realAbs = realpathSync(abs);
    const realRel = relative(realRoot, realAbs).split(sep).join('/');
    if (realRel.startsWith('..') || BLOCKED_PATH.some((re) => re.test(realRel))) {
      console.error(`Skipping ${rel}: resolved target is outside the repo or blocked.`);
      continue;
    }

    out += `\n\n=== FILE: ${rel} ===\n\n${readFileSync(realAbs, 'utf8').trimEnd()}\n`;
  }
  return out;
}

// ---- assemble -------------------------------------------------------------
const readFirst = read('docs/claude/READ-FIRST.md');
if (!readFirst) {
  console.error('docs/claude/READ-FIRST.md is missing. Restore it before running this script.');
  process.exit(1);
}

const files = {
  '00-READ-FIRST.md': readFirst + '\n',
  '01-state.md': buildState(),
  '02-rules.md': '# Rules for coding agents' + section('AGENTS.md') + section('rooms/AGENTS.md'),
  '03-plan.md':
    '# Plan, status and decisions' +
    section('SPEC-v2-game-platform.md') +
    section('docs/STATUS.md') +
    section('docs/DECISIONS.md') +
    section('docs/v1-summary.md'),
  '04-last-handoff.md': (read('docs/HANDOFF.md') ?? '(docs/HANDOFF.md does not exist yet)') + '\n',
};
const extra = buildExtra(process.argv.slice(2));
if (extra) files['05-extra.md'] = extra;

for (const [name, text] of Object.entries(files)) assertNoSecrets(name, text);

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let totalChars = 0;
console.log('\nclaude-context/');
for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(outDir, name), text);
  totalChars += text.length;
  console.log(`  ${name.padEnd(22)} ${String(text.length).padStart(7)} chars  (~${Math.round(text.length / 4).toLocaleString()} tokens)`);
}
const tokens = Math.round(totalChars / 4);
console.log(`\nTotal ~${tokens.toLocaleString()} tokens.`);
if (tokens > WARN_TOKENS) console.log(`That is large (over ${WARN_TOKENS.toLocaleString()}). Consider trimming docs or requesting fewer extra files.`);
console.log(`\nNext: open ${outDir}, select all files, drag them into a new Claude chat.`);
