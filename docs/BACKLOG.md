# Backlog for later phases

Items found while working on Phases 2 to 2c that were deliberately not changed.
Nothing here is done; each entry says where it belongs.

## Phase 3: to verify against a real Meta connection

- **Same ID space for the stored `instagramId` and the webhook `entry.id`.** Automations and accounts are looked up by
  `instagramAccount.instagramId` using the `entry.id` of the incoming webhook (`lib/queue/process-webhook.ts`,
  `lib/queue/dm-worker.ts`, `sender-guard`, `isOwnComment`). Confirm that the ID saved at OAuth time (Instagram
  Login user id) is the same value Meta sends as `entry.id`, and the same one that appears as `sender.id` on echoes. If
  they differ (Instagram-scoped vs app-scoped, or the Facebook Login page-linked id), events are dropped or loop
  protection misses the account's own messages.
- **Graph access token from the query string to the `Authorization` header.** The token currently travels as
  `access_token=` in the URL of Graph calls, where proxies and error messages can capture it. Needs a live connection to
  verify every endpoint (messages, comments, private replies, follow status, refresh) accepts the header.

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
