# Handoff

## Task
Apply the three Daily migrations and the backfill to DEV only.

## Where
- Date: 2026-10-23
- Branch: `v2-phase-5e-same-day-voting`
- Base: `main` at `0a7ab24 ui: daily layout, Done button, gallery navigation fixes`
- Committed? No. All Phase 5e/5f work plus admin UI changes is uncommitted.

## What was done

### 1. Confirmed DEV project
- Linked project ref: `mlynwcajwxmceglgtcat` (Dabble-Dev) — matches `.env` VITE_SUPABASE_URL.
- Previous link was to production (`ovuxjmwykaipwhbdfawg`); re-linked to dev.

### 2. Applied three migrations in timestamp order via `supabase db push`
| Migration | Status before | Status after |
|-----------|---------------|--------------|
| `20261026000000_phase5d_daily_prompts.sql` | local only | **applied on remote** |
| `20261027000000_phase5e_same_day_voting.sql` | local only | **applied on remote** |
| `20261028000000_phase5f_auto_approve.sql` | local only | **applied on remote** |

All three now show in `supabase migration list` with identical Local/Remote timestamps.

### 3. Backfill applied
- **Count query first**: `select count(*) from public.daily_entries where status = 'pending' and submitted_at is not null;` → **51 rows**
- **Backfill update**: `update public.daily_entries set status = 'approved' where status = 'pending' and submitted_at is not null;`
- **Verification count**: `select count(*) from public.daily_entries where status = 'pending' and submitted_at is not null;` → **0 rows**

51 pending submitted entries promoted to `approved`.

### 4. Grants check (read-only)
Confirmed `anon` has **no execute** on any of the four functions:

| Function | Execute grants (from `proacl`) |
|----------|--------------------------------|
| `vote_daily_entry` | `postgres`, `authenticated`, `service_role` |
| `get_daily_vote_grid` | `postgres`, `authenticated`, `service_role` |
| `submit_daily_entry` | `postgres`, `authenticated`, `service_role` |
| `admin_review_daily_entry` | `postgres`, `authenticated`, `service_role` |

`anon` is absent from all — correct.

## Verification
- `supabase migration list`: all three migrations now show matching Local/Remote timestamps.
- Backfill: 51 → 0 pending submitted entries.
- Grants: `anon` has no execute on the four functions.

## Database / infrastructure
- Migrations applied to **dev only** (project `mlynwcajwxmceglgtcat`).
- Backfill applied to dev only.
- No dev-backed test suite run (the Daily dev tests overwrite dev data).
- No production changes.
- No code changes this task.
- No commit created.

## Owner risk
- Submissions are now public without review (entries auto-approved on submit via `20261028000000`).
- Admin reject is the safety net — admin can find entries via **Approved** tab, reject them, and restore via **Rejected** tab.
- No image moderation exists (v2 Phase 6 not built).

## Open issues
- Dev-backed test suites must be run now that migrations are applied.
- The owner should run the dev-backed suites with `DEV_SERVICE_ROLE_KEY`:
  `node tests/dailySameDayVote.test.mjs`,
  `node tests/dailyVote.test.mjs`,
  `node tests/daily.test.mjs`,
  `DEV_ADMIN_EMAIL=... DEV_ADMIN_PASSWORD=... node tests/dailyAdmin.test.mjs`.

## Doc discrepancies noticed
- `docs/STATUS.md` still records the owner-maintained v2 Status table as stale for Phases 2–5. That table was not edited.

## Suggested next task
Run the dev-backed suites against the updated dev database, visually verify the submitted/vote screenshots, then commit the Phase 5e/5f branch if approved.