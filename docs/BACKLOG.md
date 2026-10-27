# Backlog for later phases

Items found while working on Phases 2 to 2c that were deliberately not changed.
Nothing here is done; each entry says where it belongs.

## Phase 3: to verify on a real Zernio connection (plan: `docs/PHASE3_ZERNIO.fa.md`)

Decision 2026-10-27: the Instagram connection runs through Zernio; direct Meta is set aside (Meta for Developers is
not available from Iran). Checklist: `docs/ZERNIO_ONBOARDING.fa.md`.

Confirmed by Zernio support on 2026-10-27 (support statements, not contract text; the TOS text governs):
no third account without a card (max 2 at once); the USD 12 credit covers accounts only; without a card a send beyond
10,000 messages in the UTC month fails with 403 `message_allowance_exceeded`, nothing is queued, e-mail warning at
7,500; private replies and comment-to-DM messages count, public replies, inbound and failed sends do not; the limit is
checked once per API call or batch, so about 10,200 is possible (how the overage is collected without a card is
unknown); DM and comment content stays while the account exists and is deleted with it (backups 30 days, ops logs
90 days); inbox and `comment.received` events carry both `account.accountId` and `account.id` (same value).
Support also said residents of Iran are allowed.

- **Gate: country eligibility: support confirmed, pending TOS conformance.** The TOS text (2026-10-09) has no
  country, sanctions or export clause, so nothing contradicts support. Section 8 still lets Zernio suspend without
  notice for any reason. Not legal advice.
- **Gate 1: does the free plan include Inbox?** `lib/zernio/route-handler.ts` maps HTTP 402 to "needs Inbox access".
  Still unconfirmed; if Inbox is paid, the Zernio path is not usable without a card.
- **Gate 2: real inbox payload.** Save one real Instagram event (no keys) and check `account.accountId` next to
  `account.id`. **Proposal, not done:** read `account.accountId ?? account.id` in one shared helper used by
  `lib/zernio/normalize-event.ts` (schema line 10, compare line 42) and
  `app/api/zernio/webhook/[workspaceId]/route.ts` (lines 8 and 24); log a WARN event when both exist and differ; never
  route on the top-level event `id`; tests for accountId only, id only, both equal, both different, neither.
- **Gate 3: message metering.** Confirm on a real account that a private reply moves the counter, and whether
  `GET /v1/usage` exposes a message count (support did not confirm a counter).
- **Message budget control** (design in section 6 of the plan): team-wide UTC-month counter at `postZernioMessage`;
  thresholds 7,000 warn, 8,500 hold P1/P2, 9,500 hard stop of all automatic sends; held messages get a new status
  (`HELD_BUDGET`, migration needed, `EXPIRED_HELD` after the 7-day private-reply / 24 h DM window) and one merged
  notification goes to the sales team; 403 `message_allowance_exceeded` is read by `code` only, ends the job with
  `UnrecoverableError` and holds the message; soft quota per workspace; monthly AI budget
  (`AI_MAX_REPLIES_PER_DAY=300` alone is up to 9,000 messages a month). `lib/billing/usage.ts` counts only some send
  paths and uses server-local months, so it cannot be reused as is.
- **Connection order:** disconnect the `@back.linky` test account first, then connect only Farhang Rasaneh with all
  automations paused; Mariatamlik after the webhook test and the budget control.
- **Privacy:** connecting a brand stores real customer conversation history at Zernio; privacy policy update on both
  sites, no sensitive data in forms or AI chats, delete the Zernio account when the relationship ends.
- **Zernio webhook hygiene:** dedupe on `X-Zernio-Event-Id` (the payload `id`) before queueing; answer within 5 s;
  there is no signed timestamp, so replays rely on our idempotency; alert when no event arrives for hours; Zernio
  disables an endpoint after 3 days of failures (does re-registering re-enable it?); subscribe to
  `account.connected` / `account.disconnected`; no secret rotation yet.
- **Still not read:** the "Payment method required" page, OpenAPI (`/api/openapi`), Zernio's security and privacy
  review guide, the SOC 2 report (needs a work e-mail). Privacy, DPA and subprocessors were read through a
  summarising fetch tool only; re-read the exact clauses before relying on them.
- **Direct-Meta only, lower priority now:** same ID space for the stored `instagramId` and the webhook `entry.id`;
  Graph access token from the query string to the `Authorization` header.

## CI / release (from the rc2 review)

- **`latest` is attached to release candidates.** `.github/workflows/docker-publish.yml` sets
  `flavor: latest=${{ startsWith(github.ref, 'refs/tags/v') }}`, which is true for `v0.2.1-fa.rc2` too; the rc2 run
  pushed `:latest` (index `sha256:22aa7034...`). Proposal, not done: `latest=auto` (the metadata action skips it for
  prerelease semver) or `latest=${{ startsWith(github.ref, 'refs/tags/v') && !contains(github.ref_name, '-') }}`, and
  correct the header comment that says every tag `vX.Y.Z` gets `:latest`. Deploy by digest regardless.
- **The release scan has no secret scanner.** The merge job runs Trivy with `--scanners vuln` only. Proposal, not
  done: `--scanners vuln,secret` (and print rule ids and file paths only, never matches).

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

## Zernio ingestion (from Phase 4a)

- Handle `account.connected` / `account.disconnected` (today only logged): mark the connection, notify the owner.
- Reject events whose `timestamp` is older than 6 days or more than 5 minutes ahead (proposal in `docs/ZERNIO_INGESTION.fa.md`).
- Zernio post picker: confirm which id `GET /accounts/{id}/posts` returns, and match campaigns on `platformPostId`.
- Decide whether a customer's reply to the page's public reply should start a campaign (today it does, as on Meta).
- Check against a fresh real webhook that Zernio's signature is HMAC-SHA256 over the raw body with our secret.
