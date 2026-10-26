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

## Phase 2: fixes (2026-10-26)

Branch `fix/phase2-security` (from `chore/phase0-setup`, not pushed). Status per finding, test results and
deviations: `docs/PHASE2_REPORT.md`. Supplementary review of dm-worker, rate limiter and CI:
`docs/PHASE2_SUPPLEMENTARY_REVIEW.md`. Deployment procedure: `docs/DEPLOYMENT.fa.md`.

Migrations added: `20261026090000_invitation_token_hash`, `20261026100000_sms_consent_and_guards`,
`20261026110000_user_session_version`.

Upstream files touched (merge-sensitive): `prisma/schema.prisma`, `Dockerfile`, `docker-compose.yml`, `Caddyfile`,
`next.config.ts`, `package.json`/`package-lock.json`, `install.sh`, `install.ps1`, `.env.example`, `.github/workflows/*`,
`scripts/cron.sh`, `lib/auth.ts`, `lib/env.ts`, `lib/meta/oauth.ts`, `lib/users/*`, `lib/sms/campaigns.ts`,
`lib/ai/{assistant,llm,settings}.ts`, `lib/forms/{answers,api,engine}.ts`, `lib/queue/process-webhook.ts`,
`lib/tracking/server.ts`, `lib/workspace-access.ts`, `lib/workspace-invitations.ts`, `lib/i18n/fa.json`, and these routes:
`app/api/{workspace/members,workspace/invitations/accept,webhook,zernio/webhook,sms/*,contacts/*,media/*,commands/*,forms/*,sequences/*,showcases/*,simulator,ai/*,automations,cron/*,health,instagram/{connect,callback}}`,
`app/{setup,invite/[token],r/[slug]}`, `app/(dashboard)/{settings,sms,contacts,forms/[id]}`.

New files (ours, merge-free): `lib/net/*`, `lib/ops/{retention,webhook-alerts}.ts`, `lib/sms/guards.ts`,
`lib/ai/guard.ts`, `lib/users/{setup-token,session-version}.ts`, `lib/tracking/click-limit.ts`,
`lib/utils/http-url.ts`, `scripts/rotate-encryption-key.ts`, `.github/dependabot.yml`, `docs/*`, tests.

Verification: typecheck clean; lint 0 errors (1 warning in upstream `invitation-accept-card.tsx`); 737 tests green in
three consecutive full runs with Postgres; `npm run build` passes; Docker image built and the compose stack booted
(non-root, health, headers, cron isolation) and was then removed.

### Phase 2 approval and accepted deviations (2026-10-26)

Approved by the owner with these deviations recorded:
- `/api/contacts/export` is ADMIN+ only (MEMBER may view and edit contacts, not bulk-export them).
- F18 (adding an existing user to a workspace without their acceptance) not changed: invitation auto-accept by matching
  email in `ensureWorkspaceForUser` is what `createInvitedUser` relies on; internal staff-only instance.
- F23 not done: `tsx` and `prisma` are devDependencies the image needs; `ProcessedComment` kept to keep upstream merges cheap.
- The Dockerfile `USER node` change landed in commit `3b046ea` (cron auth) instead of its own commit; history not rewritten.
- Deferred to later phases: moving the Graph access token from query string to the Authorization header (Phase 3, needs a
  real Meta connection to verify); hiding manager-only buttons from MEMBER in the UI (Phase 4).

Working rule added to the project `CLAUDE.md`: never print raw `docker compose config` or environment output; always filter secrets.

## Phase 2b: follow-ups from the supplementary review (2026-10-27)

Branch `fix/phase2-security` (both it and `chore/phase0-setup` pushed to `exwarden/pasokh`; no tag).

- S1 `lib/automation/sender-guard.ts`: per sender and account, `AUTO_REPLIES_PER_SENDER_PER_HOUR` (20) and
  `LOOP_MESSAGES_PER_MINUTE` (10 in 60 s pauses automatic replies for an hour, one event). Echoes: both webhook parsers
  drop them and `processMessage` now refuses `senderId === instagramAccountId` too.
- S6 `lib/ai/assistant.ts`: `finalAttempt` (from BullMQ `attemptsMade`/`opts.attempts`) turns a busy provider into the handoff
  message; not sent, and an event recorded, when the 24 h window is closed.
- S4 `lib/users/login-throttle.ts`: 300 ms deadline; sign-in and setup refuse with their own message when counters are unreadable.
- S2/S3 `lib/utils/rate-limiter.ts`: sliding-window sorted set, cap 600 (`PRIVATE_REPLIES_PER_HOUR`), new key `rate:dm:z:*`.
  Tested on a real Redis (`TEST_REDIS_URL`).
- S5 `lib/ops/events.ts`: one event per kind per `EVENT_COALESCE_MINUTES` (10) with `payload.repeats`. Worker failure messages no
  longer contain the job id (it is in the payload).
- CI: `docker-publish.yml` calls `ci.yml` (now `workflow_call`, with a Redis service) and scans each image with a digest-pinned
  Trivy before tagging; accepted nodemailer advisories are in `.trivyignore`.
- Not done by instruction: Graph token to Authorization header (Phase 3); hiding manager-only buttons from MEMBER (Phase 4).

Upstream files touched in 2b: `lib/queue/dm-worker.ts` (two call sites and the failure recorder), `lib/utils/rate-limiter.ts`,
`lib/users/{login-throttle,accounts}.ts`, `lib/auth.ts`, `app/login/page.tsx`, `app/setup/page.tsx`, `.github/workflows/*`.
