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

Branch `fix/phase2-security` (from `chore/phase0-setup`; pushed to `origin` = `exwarden/pasokh`, never to `upstream`). Status per finding, test results and
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

Branch `fix/phase2-security` (pushed to `origin` = `exwarden/pasokh` up to `6f62fa7`; the six Phase 2c commits (up to `270f8fd`) were pushed afterwards; nothing goes to `upstream`; no tag).
Pull requests (opened 2026-10-27, not merged): exwarden/pasokh#1 (`chore/phase0-setup` to `main`) and #2 (`fix/phase2-security` to `chore/phase0-setup`).

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

## Phase 2c: fixes from the independent review (2026-10-27)

Branch `fix/phase2-security`; each item is one commit, written test-first (the test failed before the fix).

- Items 1, 9: `lib/workspace-members.ts` `grantWorkspaceRole` is the only way a membership is created or changed by invite,
  add-member and accept; the role update is `updateMany ... role <> OWNER`, so an OWNER is never touched.
- Item 4: a changed phone number (contact API, form `saveTo`) clears `smsConsent`, `smsConsentAt`, `smsConsentSource`. An admin
  may record consent for the new number in the same request. `lib/forms/engine.ts` gained `saveAnswerToContact`.
- Item 3: `/api/ai` PUT refuses a stored key when provider or base URL changes and no new key is sent.
- Item 2: `reserveLoginAttempt` (INCR per key in one MULTI, before `verifyPassword`) replaces `isLoginThrottled` +
  `recordLoginFailure`; success clears the email counters and gives the address its slot back. Setup counts every attempt
  (not only wrong tokens), so five form mistakes in 15 minutes lock `/setup` for the window.
- Item 5: `lib/ai/guard.ts` also holds back amounts in Persian words, capacity/stock phrases and bare domains (`shop.ir`,
  `t.me/x`); the evidence is now persona + knowledge only (customer text and earlier turns no longer count).
- Items 6, 12: `.env.example` and `docs/DEPLOYMENT.fa.md` mark `TRUSTED_PROXY`, `PASOKH_BIND=127.0.0.1`, `SETUP_TOKEN`
  (`openssl rand -hex 32`) as required; sign-in by emailed link is refused while `ALLOWED_EMAILS` is empty.
- Item 10: `proxy.ts` guards every folder of `app/(dashboard)` except `/reports` (public share links live under it).
- Item 11: `processSmsBatch` stops a campaign whose provider differs from the one in the current SMS settings.
- Item 9 (tests): `member-permissions.test.ts` reads the route list from disk, fails on a route or method outside the matrix,
  pins exact statuses, and checks every query carries the workspace id.

Upstream files touched: `app/api/workspace/{members,invitations/accept}/route.ts`, `lib/workspace.ts`,
`app/api/contacts/[id]/route.ts`, `lib/forms/engine.ts`, `app/api/ai/route.ts`, `lib/users/{login-throttle,accounts}.ts`,
`app/setup/page.tsx`, `lib/ai/{guard,assistant}.ts`, `lib/env.ts`, `lib/auth.ts`, `proxy.ts`, `lib/sms/campaigns.ts`.

### Phase 2c, second round (2026-10-27)

- Item 7: `lib/net/safe-fetch.ts` `postJson` connects through a custom `lookup` that refuses private answers, so the checked
  address is the one connected to (no second resolve), reads at most 1 MiB, follows no redirect. `safe-url.ts` now parses
  IPv6 to bytes and refuses `::/96`, `64:ff9b:1::/48`, 6to4, Teredo, `100::/64`, `fec0::/10`; NAT64 `64:ff9b::/96` is judged by
  its embedded IPv4. `lib/ai/models.ts` split out of `llm.ts` (the client page imports the list).
- Item 8: `sender-guard.ts` is `checkLoop` (every message and button tap) plus `checkAutoReplyCap` (only what would start a
  reply; form answers, menu taps and comment-prompt answers return earlier and are not counted). Redis failure still allows,
  now with an event "Sender limits could not be checked".
- `vitest.config.ts`: `hookTimeout` 120 s (database tests build a schema in `beforeAll`).


### Phase 2d (2026-10-27)

- `scripts/smoke-safe-fetch.ts` (`npx tsx scripts/smoke-safe-fetch.ts`): `postJson` with the custom `all: true` lookup,
  no mocks, on Node 24.19. Dual-stack (`example.com`) and IPv4-only hosts connect over TLS; a name resolving to 127.0.0.1
  is refused. The IPv6-only case could not be checked: the local resolver returns no AAAA records at all, even for
  `ipv6.google.com`, so the script reports it as UNREACHABLE, not as a pass.
- Comment path: a person commenting the keyword N times got N DMs (dedupe was per campaign and comment only). Now one DM
  per campaign and person per `COMMENT_DM_COOLDOWN_HOURS` (default 24, 0 = off), logged as `SKIPPED_DEDUP`. New file
  `lib/automation/comment-cooldown.ts`; upstream file touched: `lib/queue/dm-worker.ts` (one block before the plan-limit
  check). Migration `20261027090000_dmlog_commenter_index` adds `DmLog(automationId, commenterId)`. The public comment
  reply is still posted per comment. Two comments handled at the same moment by two workers can both pass the check.
- `docs/BACKLOG.md` lists the unverified Phase 3 items and the Phase 4/5 backlog.

### Merge status (2026-10-27)

- PR #1 (`chore/phase0-setup`) merged into `main` of `exwarden/pasokh`; the old `docker-publish.yml` on `main` published an
  untagged-by-release image from that merge (no CI gate, no scan). Do not deploy from it.
- PR #2 (`fix/phase2-security`) merged into `main` at 2026-10-27T08:39:44Z, merge commit
  `2221ae9e515522725a101b32727793ebd6dd4486`. CI on the PR (run 40474024044) passed. Nothing was merged into `upstream`.
