# دریافت رویدادهای Zernio: یافته‌های payload واقعی و وضعیت تأیید

زمینه: [PHASE3_ZERNIO.fa.md](PHASE3_ZERNIO.fa.md) (بخش‌های ۸ و ۱۲). تاریخ: 2026-10-27. منبع: ۷ رویداد واقعی از یک حساب آزمایشی (فقط داده‌ٔ تست). نمونه‌ٔ خام عمداً بیرون از ریپو است؛ fixtureهای sanitize‌شده در `__tests__/fixtures/zernio/` هستند (همهٔ نام‌ها، شناسه‌ها، URLها و امضاها ساختگی‌اند، ولی طول و شکل فیلدها حفظ شده است).

## تأییدشده با نمونهٔ واقعی

| موضوع | یافته | اثر در کد |
|---|---|---|
| شناسهٔ حساب | `account.id` و `account.accountId` در هر ۷ رویداد یکسان‌اند | `getZernioAccountId()` = `accountId ?? id`؛ اگر هر دو باشند و فرق کنند فقط WARN (بدون چاپ مقدار) |
| هدرها | `x-zernio-signature` (۶۴ نویسهٔ hex)، `x-zernio-event-id` (برابر `id` بدنه)، `x-zernio-event`، و همان سه مقدار با نام قدیمی `x-late-*` | `readZernioHeaders()`: اول `x-zernio-*`، بعد `x-late-*`؛ بدون هیچ‌کدام رد می‌شود |
| پاسخ عمومی خود صفحه | با `comment.received`، `author.isOwnAccount=true` و `isReply=true` می‌آید | رد در `normalizeZernioEvent` پیش از هر اتوماسیون |
| شناسهٔ حساب خودمان | سه شناسهٔ متفاوت: `account.id`، `comment.author.id`، `message.sender.id` | تشخیص «از خودمان» فقط با پرچم `isOwnAccount`، نه مقایسهٔ شناسه |
| `message.sent` | رویداد جدا با `direction=outgoing` و `sentVia` (`human` در نمونه‌ها) | فقط ثبت می‌شود؛ به صف اتوماسیون/AI نمی‌رسد |
| کامنت | `postId`، `post.permalink`، `post.content` همه `null`؛ فقط `platformPostId` پر است | تطبیق پست با `platformPostId` (پایین‌تر را ببینید) |
| طول شناسه‌ها | `platformMessageId` در نمونه‌ها ۱۶۴ نویسه (کمتر از «حدود ۲۰۰» ذکرشده) | ستون‌ها `TEXT` هستند؛ نیاز به migration نبود |
| پیوست | URL امضاشده و منقضی‌شونده در `attachments[].url` و `payload.url` | فقط `type` ادامه می‌یابد |
| `timestamp` | در بدنه هست و کل بدنه امضا می‌شود | بررسی تازگی فقط پیشنهاد شده (پایین) |

## هنوز تأییدنشده

1. **تطبیق با امضای واقعی Zernio.** secret نمونه‌ها حذف شده بود، پس هیچ امضایی روی نمونهٔ واقعی محاسبه نشد. تست‌ها با secret ساختگی و امضای محاسبه‌شده در خود تست کار می‌کنند. فقط قالب (۶۴ نویسهٔ hex) از نمونه‌ها تأیید شد. اینکه Zernio دقیقاً HMAC-SHA256 روی بایت‌های خام بدنه، بدون prefix و با همان secret ما محاسبه می‌کند باید در تست سرتاسری (webhook تازه به endpoint خودمان) تأیید شود.
2. **رفتار `message.sent` برای پاسخ خصوصی از دکمهٔ DM.** معلوم نیست این پاسخ `message.sent` تولید می‌کند یا نه. هیچ مسیر کدی به آن وابسته نیست.
3. **شناسهٔ پست در لیست پست‌های Zernio.** `GET /accounts/{id}/posts` در `lib/instagram/read-content.ts` فیلد `id` را برمی‌گرداند و به‌عنوان `automation.postId` ذخیره می‌شود، ولی webhook فقط `platformPostId` (شناسهٔ اینستاگرام) می‌دهد. اگر `id` در آن پاسخ شناسهٔ داخلی Zernio باشد، کمپین‌های «فقط این پست» هیچ کامنتی را تطبیق نمی‌دهند. نمونهٔ واقعی پاسخ لازم است.
4. **مسیر پاسخ خصوصی.** `postZernioMessage` از `/inbox/comments/{postId ?? commentId}/{commentId}/private-reply` استفاده می‌کند و برای `postId` مقدار `platformPostId` می‌رود. اینکه Zernio این مقدار را به‌جای شناسهٔ داخلی خودش می‌پذیرد تأیید نشده.
5. **رویدادهای `account.connected` و `account.disconnected`:** ساختار payload دیده نشد؛ فقط لاگ می‌شوند.
6. **پاسخ مشتری به کامنت صفحه** (`isReply=true`، `isOwnAccount=false`) مثل Meta یک کامنت عادی حساب می‌شود و ممکن است کمپین را فعال کند. تصمیم محصولی لازم است.

## dedupe

- جدول `ZernioEventReceipt` با یکتایی `(workspaceId, eventId)`. `eventId` = `id` بدنه؛ اگر `x-zernio-event-id` فرق کند WARN و `id` بدنه معیار است.
- رسید پیش از پردازش ثبت می‌شود. اگر پردازش شکست بخورد رسید پاک و ۵۰۰ برگردانده می‌شود تا retry خود Zernio پردازش شود. تکراری: ۲۰۰ با `duplicate: true`.
- پیش‌تر فقط `jobId` در BullMQ (برای کامنت و پیام) جلوی صف شدن دوباره را می‌گرفت و هر تحویل یک ردیف `WebhookEvent` می‌ساخت؛ postback و read رویدادها `jobId` مستقل از event id داشتند. حالا تحویل تکراری پیش از هر کاری قطع می‌شود.
- TTL پیشنهادی و پیاده‌شده: ۷ روز (`ZERNIO_EVENT_RECEIPT_RETENTION_DAYS`)؛ Zernio تا حدود ۵۱ ساعت retry می‌کند.
- **بررسی تازگی `timestamp` (فقط پیشنهاد، پیاده نشده):** رد کردن رویدادی که `timestamp` آن از ۶ روز قدیمی‌تر یا بیش از ۵ دقیقه در آینده باشد. ۶ روز یعنی کمتر از TTL رسیدها، پس یک بدنهٔ امضاشدهٔ قدیمی نمی‌تواند پس از پاک شدن رسیدش دوباره اجرا شود، و retryهای تأخیری ۵۱ ساعته هم رد نمی‌شوند.

## message.sent

جدول `ZernioSentMessage` با یکتایی `(workspaceId, platformMessageId)`؛ فقط `sentVia`، `hasAttachments` و `sentAt`. متن و URL پیوست ذخیره نمی‌شود. در `WebhookEvent` هم نوشته نمی‌شود. پیاده‌سازی upsert است، پس همان پیام با event id جدید ردیف دوم نمی‌سازد. جدول موجود پیام‌ها وجود نداشت، به همین دلیل جدول جدید ساخته شد؛ ۹۰ روز نگهداری (`ZERNIO_SENT_MESSAGE_RETENTION_DAYS`).

## محافظ حلقه

- sender-guard (`lib/automation/sender-guard.ts`) هویت فرستنده را بررسی نمی‌کند؛ فقط نرخ پیام هر فرستنده را می‌شمارد (۱۰ پیام در دقیقه = حلقه، ۲۰ پاسخ در ساعت). پاسخ عمومی خود صفحه را متوقف نمی‌کرد.
- `isOwnComment` (id و username) در `process-webhook` فقط وقتی کار می‌کند که `author.id` برابر `instagramId` ذخیره‌شده یا username برابر باشد. شناسه‌های واقعی فرق می‌کنند، پس فقط تطبیق username جلوی آن را می‌گرفت.
- حالا هر کامنت با `author.isOwnAccount=true` و هر پیام `outgoing` پیش از ورود به process-webhook حذف می‌شود. تست: fixture ۶ (هم unit، هم سرتاسری روی Postgres).

## تطبیق پست در کامنت

- `dm-worker` کمپین را با `postId: mediaId` تطبیق می‌دهد و `mediaId` = `platformPostId`. به `permalink` یا `content` یا `postId` تکیه‌ای نیست، پس `null` بودن آن‌ها چیزی را نمی‌شکند.
- ریسک‌های واقعی: موارد ۳ و ۴ بخش «تأییدنشده». پیشنهاد (پیاده نشده): در `getUserMedia` اگر پاسخ Zernio `platformPostId` دارد همان را به‌عنوان `id` برگردان؛ در صورت نبودن آن، تطبیق با هر دو شناسه.

## پیوست‌ها

URL پیوست و `storyUrl` دیگر وارد payload نرمال‌شده، `WebhookEvent` و داده‌ٔ job نمی‌شوند؛ هیچ کدی آن‌ها را نمی‌خواند. نوع و وجود/تعداد پیوست می‌ماند. اگر روزی دانلود لازم شد باید از `lib/net/safe-fetch.ts` رد شود.

## ماشین حالت رسید (فاز ۴-الف۲)

- `ZernioEventReceipt.status` = `CLAIMED` (در حال پردازش) یا `ENQUEUED` (jobها در صف‌اند)، به‌همراه `claimedAt`. رسیدهای قبل از migration مقدار `ENQUEUED` گرفتند، پس بازپردازش نمی‌شوند.
- تحویل تکراری: `ENQUEUED` ← ۲۰۰ با `duplicate:true`؛ `CLAIMED` قدیمی‌تر از `ZERNIO_CLAIM_STALE_SECONDS` (پیش‌فرض ۱۲۰) ← تصاحب با `updateMany` اتمیک و بازپردازش؛ `CLAIMED` تازه ← ۵۰۳ با `Retry-After: 30`. شکست پردازش، رسید را پاک می‌کند.
- بازپردازش امن است چون `jobId`ها و claimهای ماندگار worker ارسال مضاعف را می‌گیرند (شاهد در گزارش PR).
- اگر علامت‌گذاری `ENQUEUED` شکست بخورد، رسید `CLAIMED` می‌ماند و تحویل بعدی همان کار (idempotent) را دوباره انجام می‌دهد.

## سقف بدنه

`WEBHOOK_MAX_BODY_BYTES` (پیش‌فرض ۲۵۶ KiB) روی route زرنیو و route مستقیم Meta: `Content-Length` بزرگ‌تر ← ۴۱۳ پیش از خواندن؛ خواندن stream با شمارندهٔ بایت و قطع روی سقف. در `Caddyfile` فقط برای `/api/zernio/webhook/*` و `/api/webhook*` مقدار `max_size 256KiB` (نه KB، که ۲۵۶٬۰۰۰ بایت است و از سقف برنامه کمتر می‌شد). بدنه‌های واقعی زرنیو ۰٫۷ تا ۲٫۴ کیلوبایت‌اند. Meta ممکن است در یک batch بزرگ‌تر بفرستد؛ مسیر مستقیم Meta در برنامهٔ فعلی استفاده نمی‌شود.

## شبکهٔ ایمنی reconciler (محدودیت‌ها)

- **DMها شبکهٔ ایمنی ندارند.** `reconcileComments` فقط کامنت‌ها را دوباره می‌خواند. هیچ sweep ای برای پیام‌های دریافتی نیست (`lib/instagram/read-inbox.ts` به هیچ کار دوره‌ای وصل نیست). DM گمشده فقط با retry خود Zernio برمی‌گردد.
- **کامنت‌ها به شناسهٔ پست وابسته‌اند.** reconciler کامنت‌های `automation.postId` را می‌خواند. اگر آن مقدار شناسهٔ داخلی Zernio باشد و نه `platformPostId`، هم تطبیق webhook و هم جبران reconciler شکست می‌خورد (بخش «هنوز تأییدنشده»، مورد ۳). پنجره: ۷۲ ساعت، حداکثر ۳۰ کامنت در هر sweep، هر ۵ دقیقه.

