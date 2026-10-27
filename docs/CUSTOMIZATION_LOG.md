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

### Phase 3 decision (2026-10-27)

- Meta direct is set aside: a Meta Developer account cannot be created from Iran. The connection runs through Zernio.
  `CLAUDE.md` (parent folder, outside this repository) was updated: rule 1, Phase 3, and a "Decision" section.
- Added `docs/PHASE3_ZERNIO.fa.md` (documentation findings, terms of use, Zernio path in the code, risks, message budget
  design, estimates) and `docs/ZERNIO_ONBOARDING.fa.md` (checklist). `docs/BACKLOG.md` updated. No code changed.

### Zernio support answers and docs review (2026-10-27)

- `docs/PHASE3_ZERNIO.fa.md`, `docs/ZERNIO_ONBOARDING.fa.md` and `docs/BACKLOG.md` updated with the Zernio support
  answers (Ana, Elean), the TOS / Privacy / DPA / subprocessors / Trust Center pages and the webhook documentation.
  New sections: privacy risk, free-tier limits with the manual fallback, brand connection order, and the
  `account.accountId` proposal. Budget design now uses 7,000 (warn), 8,500 (hold P1/P2) and 9,500 (hard stop of all
  automatic sends), with held messages and a merged sales notification, and 403 `message_allowance_exceeded` handling.
- TOS (updated 2026-10-09): no country, sanctions or export clause; section 8 allows suspension without notice for any
  reason. Consistent with support's statement; gate marked "support confirmed, pending TOS conformance". Not legal advice.
- No code changed. `normalize-event.ts` and the webhook route still read `account.id` only; the change is a proposal.

### rc2 release review (2026-10-27)

- Tag `v0.2.1-fa.rc2` on commit `e6e8525655b33f2559ba4d8692d31767b4c668ae` (merge of PR #3); publish run 40500474514
  succeeded. Final manifest (index): `ghcr.io/exwarden/pasokh@sha256:22aa70348bd34af79bbe2cf7dcd8caffbbb6f3ac5146b81f5a63ba3572d3f900`,
  tags `0.2.1-fa.rc2`, `sha-e6e8525` and `latest` (all three resolve to the same digest).
- The digests the CI scanned (`56fe79bf...` arm64, `d443c4ae...` amd64) are the per-architecture indexes pushed by the
  build jobs. `docker buildx imagetools inspect` shows `56fe79bf...` holds image `c7fb5f74...` (linux/arm64) plus its
  attestation `d9e65979...`, and `d443c4ae...` holds `f9b135a4...` (linux/amd64) plus attestation `5b156e7f...`. The
  final index `22aa7034...` lists exactly those four manifests (merge job log: "copying ... from ...@sha256:56fe79bf" /
  "...d443c4ae"). So the scanned images are the ones under the final manifest.
- Trivy in CI (pinned `aquasec/trivy@sha256:790fd66d...`, `--scanners vuln`, HIGH/CRITICAL, fixable only): 0 findings on
  both architectures. Note: that step does not look for secrets.
- Secret scan run locally on the final digest, both platforms (Trivy 0.76.1, same pinned image,
  `--scanners secret`, JSON output, only rule ids and paths read): 0 secrets in OS packages and Node.js targets. Image
  config: environment variable names are PATH, NODE_VERSION, YARN_VERSION, NODE_ENV, NEXT_TELEMETRY_DISABLED,
  PASOKH_DATA_DIR (values not read); user `node`; no layer history entry mentions password, secret, token or api_key; no
  `.env*`, `.git`, `.npmrc`, `*.key` or private-key files outside `node_modules` and system certificate stores (only the
  system `cert.pem`). This reduces the risk; it is not proof that nothing sensitive exists.
- `:latest` was attached to the release candidate: the workflow forces `latest=true` for every `v*` tag. Proposal in
  `docs/BACKLOG.md` (not changed). Also proposed: add `secret` to the CI scan.

### Phase 4a: Zernio ingestion (2026-10-27)

Branch `feat/zernio-ingestion-fixes`. Findings and the verified/unverified split: `docs/ZERNIO_INGESTION.fa.md`.

- `lib/zernio/normalize-event.ts`: `getZernioAccountId` (`accountId ?? id`, WARN when they differ), `readZernioHeaders`
  (`x-zernio-*` then `x-late-*`), `resolveZernioEventId`, `parseZernioSentMessage`; `verifyZernioSignature` takes bytes.
  Comments with `author.isOwnAccount` are dropped. Attachment and story URLs no longer travel on.
- `app/api/zernio/webhook/[workspaceId]/route.ts`: signature over the raw bytes, event-id claim
  (`ZernioEventReceipt`, released on failure), `message.sent` recorded in `ZernioSentMessage` only, `account.connected` /
  `account.disconnected` logged.
- Migration `20261027120000_zernio_event_receipts` (two new tables). `lib/ops/retention.ts` prunes receipts after 7 days and
  sent-message rows after 90. No external-id column was `VarChar`, so no column migration was needed.
- Fixtures: `__tests__/fixtures/zernio/` (sanitized). Tests: `zernio-ingestion.test.ts`, `zernio-webhook-route.db.test.ts`.
- Upstream-derived files touched: `lib/ops/retention.ts`, `.env.example`, `__tests__/retention.test.ts`.
- Not verified: the signature against Zernio's real one (secret was not available).

### Phase 4a-2: ingestion hardening (2026-10-27)

Branch `feat/zernio-ingestion-hardening` (stacked on `feat/zernio-ingestion-fixes` until that merges).

- Receipt state machine: `ZernioEventReceipt.status` (CLAIMED | ENQUEUED) and `claimedAt`, migration
  `20261027150000_zernio_receipt_status` (existing rows become ENQUEUED). `lib/zernio/receipt.ts` claims, takes over stale
  claims atomically (`ZERNIO_CLAIM_STALE_SECONDS`, 120) and marks ENQUEUED; a fresh duplicate gets 503.
- Body cap: `lib/net/read-body-limited.ts` (`WEBHOOK_MAX_BODY_BYTES`, 256 KiB) on the Zernio and Meta webhook routes, and
  `request_body { max_size 256KiB }` in the `Caddyfile` for the webhook paths only. Upstream-derived files touched:
  `app/api/webhook/route.ts`, `Caddyfile`, `.env.example`.
- Known limits recorded: DMs have no reconciler safety net (only comments do), and the comment reconciler depends on
  `automation.postId` being the Instagram media id (`docs/ZERNIO_INGESTION.fa.md`).

### AI reply delivery hardening (2026-10-27)

Branch `feat/ai-reply-delivery-hardening`. Migration `20261027170000_ai_reply_claim` (`AiReply.claimedAt`, `AiReply.attempts`).
Upstream-derived files touched: `lib/ai/assistant.ts`, `.env.example`, `__tests__/ai-allowed-facts.test.ts` (mock only).

- `SENDING` state: the reply moves PENDING -> SENDING atomically right before `sendOutboundMessage`. A retry that finds
  SENDING marks the row `UNCONFIRMED` (existing status, shown in the assistant's recent replies) and records the warning
  event "The AI assistant could not confirm a reply"; it never sends again. A rate-limited send is put back to PENDING.
- A PENDING reply with no stored answer older than `AI_PENDING_STALE_MINUTES` (5) is taken over with an atomic
  `updateMany`; a fresh one is left alone.
- The daily limits now sum `AiReply.attempts` instead of counting rows: a takeover that calls the model again counts, a
  takeover is refused (row marked FAILED, outcome LIMIT) when that call would pass a limit, and sending a stored answer
  costs nothing.
- Known limit: a live second job that reads a row in SENDING marks it UNCONFIRMED; the first job's final update then
  overwrites it with the real outcome, so only a spurious warning event is possible.

