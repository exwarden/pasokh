# Customization log

Tracks every change made in the `exwarden/pasokh` fork relative to upstream
`ArminShirzad/pasokh`, why, and which upstream files were touched.

## Base

- Upstream: `ArminShirzad/pasokh` (remote `upstream`), fork: `exwarden/pasokh` (remote `origin`).
- Base commit (`main` at clone time): `72ec1c5070f6bd17e5c6528b89152384f22b6a63`
  ("Text-only comment replies ignored edited button labels", 2026-10-25), version 0.2.0.

## Phase 0: setup (2026-10-26)

- Added this file. No upstream files touched.
- Local `.env` generated with random secrets (git-ignored, never committed).

### Baseline (Windows 11, Node v24.19.0, npm 11.17.0, Docker 29.9.2, Compose v5.6.1)

- `npm run typecheck`: clean. `npm run lint`: clean.
- `npm test` without `TEST_DATABASE_URL`: 44 files passed, 7 skipped; 454 tests passed, 74 skipped.
- `npm test` with `TEST_DATABASE_URL` (local Postgres 16): 528 tests. Three runs:
  1 failed (first-run-setup), 3 failed (first-run-setup x2, flows.db x1), 0 failed.
  Failures are `beforeEach` / hook timeouts at the 10 s default (`TRUNCATE "User" CASCADE`),
  i.e. slow DB on a cold start; the third run was fully green. Treat `*.db.test.ts`
  as timing-flaky on this machine.
- `npm audit`: 28 vulnerabilities (2 low, 6 moderate, 16 high, 4 critical); triage in Phase 1.
- npm 11 reports 6 packages with install scripts not run (`allowScripts`):
  prisma, @prisma/engines, esbuild, sharp, msgpackr-extract, unrs-resolver.
  Prisma generate, migrate, tests, dev server and worker all work regardless.
- Web (`next dev`, port 3000) and worker boot; `/setup` renders `lang=fa dir=rtl`.
  Owner account not created yet.

## Phase 1: code and security review (2026-10-26)

- Read-only audit; no application code changed. Findings in `docs/PHASE1_FINDINGS.md` (23 items: 5 high, 10 medium, 8 low).
- Upstream files touched: none.
- Not covered: `lib/queue/dm-worker.ts` internals, CI workflows, form/command/sequence engines, dynamic testing.
