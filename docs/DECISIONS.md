# Documentation decisions

Append new decisions; do not rewrite or remove earlier entries.

## 2026-10-22

- Keep root `AGENTS.md` focused on project-wide rules; put rooms-only rules in
  `rooms/AGENTS.md`, and load the short status and decisions docs through the
  OpenCode `instructions` configuration.
- Keep `SPEC-v2-game-platform.md` as the canonical v2 design and owner-maintained
  status source. Report status discrepancies separately; do not edit its table.
- Archive the full v1 spec and retain a short summary that points to its code,
  migration and test evidence.
- `opencode-ponytail` is an OpenCode plugin; load it through the `plugin` field
  in `opencode.json`, not as an application runtime dependency. `package.json`
  remains unchanged for this task. The root `opencode.json` is gitignored, so
  its `instructions` and `plugin` settings are local to this checkout and are
  not part of the branch diff.

## 2026-10-22 — Claude handoff workflow

- Install the Claude handoff workflow: `npm run handoff` builds a context pack
  from the current repo state for a new Claude planning chat.
- `docs/HANDOFF.md` is overwritten at the end of each task; its history is kept
  in git rather than accumulated in the file.
- `claude-context/` is generated output and gitignored; never commit it.
