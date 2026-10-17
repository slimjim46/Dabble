#!/usr/bin/env node
// Loads the owner's blocked-term list into public.blocked_terms.
//
//   node scripts/load-blocked-terms.mjs [--project dev|<ref>] [--dry-run]
//
// Reads ./blocked-terms.txt (uncommitted; this file is never in the repo and
// no word list is ever hard-coded in source). Line format:
//
//   # comment
//   some term                 -> severity 'substring' (default)
//   some term whole_word      -> severity 'whole_word'
//
// Uses the Supabase Management API (~/.supabase/access-token), the same
// channel migrations are applied with, because blocked_terms has no client
// grants at all.
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const DEV_REF = 'mlynwcajwxmceglgtcat'

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const project = arg('--project', 'dev') === 'dev' ? DEV_REF : arg('--project', 'dev')
const dryRun = process.argv.includes('--dry-run')
const listPath = resolve(process.cwd(), arg('--file', 'blocked-terms.txt'))

if (!existsSync(listPath)) {
  console.error(`No term list at ${listPath}`)
  console.error('Create blocked-terms.txt (one term per line, optional trailing "whole_word").')
  process.exit(1)
}

const tokenPath = resolve(homedir(), '.supabase/access-token')
if (!dryRun && !existsSync(tokenPath)) {
  console.error('Missing ~/.supabase/access-token (run `supabase login` first).')
  process.exit(1)
}

const sqlLines = []
for (const raw of readFileSync(listPath, 'utf8').split(/\r?\n/)) {
  const line = raw.trim()
  if (!line || line.startsWith('#')) continue
  const severityMatch = line.match(/^(.*?)\s+(substring|whole_word)$/)
  const term = (severityMatch ? severityMatch[1] : line).trim()
  const severity = severityMatch ? severityMatch[2] : 'substring'
  if (!term) continue
  if (/[\n\r]/.test(term)) {
    console.error('Refusing a term containing a newline.')
    process.exit(1)
  }
  // Single quotes are the only character that needs escaping inside '...';
  // terms never contain newlines (they come in line by line).
  sqlLines.push(
    `  ('${term.replace(/'/g, "''")}', '${severity}')`,
  )
}

if (sqlLines.length === 0) {
  console.error('No terms found in the list.')
  process.exit(1)
}

const sql = `-- load-blocked-terms.mjs
insert into public.blocked_terms (term, severity)
values
${sqlLines.join(',\n')}
on conflict (term) do update set severity = excluded.severity;
`

console.log(`Project: ${project}`)
console.log(`Terms:   ${sqlLines.length}`)
console.log(sql)

if (dryRun) {
  console.log('(dry run: nothing sent)')
  process.exit(0)
}

const token = readFileSync(tokenPath, 'utf8').trim()
const response = await fetch(
  `https://api.supabase.com/v1/projects/${project}/database/query`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  },
)

if (!response.ok) {
  console.error(`Management API error ${response.status}: ${await response.text()}`)
  process.exit(1)
}
console.log('Loaded.')
