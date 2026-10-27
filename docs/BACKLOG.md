# Backlog for later phases

Items found while working on Phases 2 to 2c that were deliberately not changed.
Nothing here is done; each entry says where it belongs.

## Phase 3: to verify on a real Zernio connection (plan: `docs/PHASE3_ZERNIO.fa.md`)

Decision 2026-10-27: the Instagram connection runs through Zernio; direct Meta is set aside (Meta for Developers is
not available from Iran). Checklist: `docs/ZERNIO_ONBOARDING.fa.md`.

- **Gate 1: does the free plan include Inbox?** `lib/zernio/route-handler.ts` maps HTTP 402 to "needs Inbox access".
  Not confirmed in the docs; if Inbox is paid, the Zernio path is not usable without a card.
- **Gate 2: webhook account field.** The docs say account events carry `account.accountId`; `normalize-event.ts` and
  the webhook route read `account.id` and drop anything else as `ignored`. Check against a real payload.
- **Gate 3: message metering.** Whether a private reply counts, the real behavior at 10,000 (403
  `message_allowance_exceeded` was not found in the readable docs), and whether `GET /v1/usage` exposes a message
  count.
- **Message budget control** (design in section 6 of the plan): team-wide UTC-month counter at `postZernioMessage`,
  P0/P1/P2 priorities with stops at 9,500 and 10,000, 403 circuit breaker, soft quota per workspace, a monthly AI
  budget (`AI_MAX_REPLIES_PER_DAY=300` alone is up to 9,000 messages a month). `lib/billing/usage.ts` counts only some
  send paths and uses server-local months, so it cannot be reused as is.
- **Zernio webhook hygiene:** dedupe on `X-Zernio-Event-Id` before queueing, answer within 5 s, alert when no event
  arrives for hours, no secret rotation yet.
- **Not read:** Zernio subprocessors page, DPA, "Payment method required" page, inbox webhook payload pages, OpenAPI.
- **Direct-Meta only, lower priority now:** same ID space for the stored `instagramId` and the webhook `entry.id`;
  Graph access token from the query string to the `Authorization` header.

## Phase 4 / 5: product and hardening

- **Public report links: safer defaults.** `Automation.reportShareEnabled` defaults to `true`; make it default to `false`,
  generate the slug from 16 random bytes, and rate limit `/reports/<slug>` (it is public and lives outside the dashboard
  guard in `proxy.ts`).
- **Tune the AI output guard against the real knowledge base.** `lib/ai/guard.ts` holds back figures, amounts, capacity
  phrases and domains that the persona and knowledge text do not contain. With the real Mariatamlik and Farhang Rasaneh
  knowledge bases, measure how many answers are held back (the `HANDOFF` rate) and adjust the patterns so a legitimate
  answer is not turned into a handoff while an invented price still is.
- **Hide manager-only buttons from MEMBER** in the dashboard UI (the API already refuses them).
- **Close the race in the comment cooldown and cap public replies.** The cooldown check
  (`lib/automation/comment-cooldown.ts`) reads `DmLog` and then sends, so two workers handling two comments from one
  person at the same moment can both pass. Claim the (campaign, person) slot atomically before sending, with Redis
  `SET key NX PX <cooldown>` (release it if the send is a confirmed rejection). Also cap public comment replies per
  person per campaign: they are still posted for every comment.
- **Comment cooldown per campaign in the UI.** `COMMENT_DM_COOLDOWN_HOURS` is a global environment setting; a
  per-campaign field would need a migration and form changes.

## Phase 6: go-live checklist additions

- Run `npx tsx scripts/smoke-safe-fetch.ts` on the VPS outside Iran. The local network has no AAAA resolution, so the
  IPv6-only case of the custom `lookup` (`lib/net/safe-fetch.ts`) has never been exercised; it must report PASS there.
