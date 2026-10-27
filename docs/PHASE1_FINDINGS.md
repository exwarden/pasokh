# گزارش فاز ۱: بازبینی کد و امنیت

تاریخ: ۲۰۲۶-۱۰-۲۶ · مبنا: `72ec1c5` (نسخه 0.2.0) · روش: خواندن کد (read-only)، اجرای `npm audit`. هیچ تغییری در کد برنامه داده نشده است.

## دامنه و محدودیت‌ها

خوانده‌شده: webhookها (Meta و Zernio)، `process-webhook`، رمزنگاری توکن، auth، دسترسی workspace و نقش‌ها، نقاط اتصال به فضای خارج (`fetch`)، ماژول AI، ماژول SMS، آپلود رسانه، ریدایرکت لینک، Dockerfile، compose، Caddyfile، installerها، `npm audit`.

**بازبینی نشده یا سطحی:** منطق داخلی `lib/queue/dm-worker.ts` (۲۱۰۰ خط)، `rate-limiter.ts`، موتورهای forms/commands/sequences، workflowهای CI، مسیرهای خواندنی `instagram/*`، تست‌های موجود. هیچ تست نفوذ پویا انجام نشده؛ همهٔ موارد از روی کد است، مگر جایی که ذکر شده.

## جدول یافته‌ها

| # | شدت | یافته | مسیر |
|---|---|---|---|
| F1 | بالا | هر عضو با نقش MEMBER توکن دعوت‌نامه‌های باز را می‌بیند و می‌تواند حساب مدعو را بسازد | `app/api/workspace/members/route.ts:41-95`، `lib/users/accounts.ts` (`createInvitedUser`) |
| F2 | بالا | `/setup` تا ساخت اولین کاربر برای همه باز است؛ نصب پیش‌فرض بلافاصله روی تونل عمومی می‌آید | `app/setup`، `lib/users/accounts.ts` (`needsFirstRunSetup`)، `install.sh` (حالت ۱) |
| F3 | بالا | استقرار از ایمیج و فایل‌های upstream می‌آید، نه از فورک ما | `docker-compose.yml:20`، `install.sh` (`REPO_RAW`)، `:latest` بدون pin |
| F4 | بالا | آسیب‌پذیری‌های وابستگی‌های production: `next` 16.2.6، `next-auth`/`@auth/core`، `zod` 4.3.6، `nodemailer`، `sharp` | `package.json` |
| F5 | بالا | ایجاد کمپین SMS بلافاصله برای همهٔ مخاطبان (تا ۱۰۰٬۰۰۰) ارسال می‌کند؛ بدون تأیید سمت سرور، سقف، یا ضد تکرار | `lib/sms/campaigns.ts:28-53`، `app/api/sms/campaigns/route.ts` |
| F6 | متوسط | محدودکنندهٔ ورود به IP قابل‌جعل اعتماد دارد؛ قفل ایمیل (۵ خطا/۱۵ دقیقه) قفل‌کردن عمدی مالک را ممکن می‌کند | `lib/auth.ts:34-37`، `lib/users/login-throttle.ts` |
| F7 | متوسط | SSRF در آدرس پایهٔ AI: هر URL پذیرفته می‌شود؛ `/api/ai/test` بخشی از پاسخ خطا را برمی‌گرداند | `lib/ai/settings.ts:13`، `lib/ai/llm.ts`، `app/api/ai/test/route.ts` |
| F8 | متوسط | هزینهٔ AI بدون سقف سراسری؛ سقف روزانه فقط پاسخ‌های SENT را می‌شمارد؛ خروجی فیلتر نمی‌شود؛ شکست مدل بی‌صدا و بدون هشدار است | `lib/ai/assistant.ts:50-58`، `lib/ai/prompt.ts` |
| F9 | متوسط | بسیاری از مسیرهای تغییر‌دهنده نقش را بررسی نمی‌کنند؛ MEMBER می‌تواند DM بفرستد، فرم/دستور/ویترین حذف کند، مخاطب ویرایش کند، AI را بیازماید | `app/api/instagram/conversations/route.ts:103`، `commands`، `forms`، `sequences`، `showcases`، `contacts/[id]`، `media`، `ai/test`، `simulator` |
| F10 | متوسط | شکست امضای webhook بدون rate limit در دیتابیس رویداد می‌نویسد (۲۰۰ بایت بدنهٔ مهاجم) | `app/api/webhook/route.ts:28-45` |
| F11 | متوسط | هیچ سیاست نگه‌داری داده نیست: `WebhookEvent` (متن کامل پیام مشتری)، `AiReply`، `DmLog`، `LinkClick`، `OperationalEvent` هرگز پاک نمی‌شوند | `prisma/schema.prisma`؛ جستجوی `deleteMany` |
| F12 | متوسط | ریدایرکت لینک: عمومی، بدون rate limit، هر کلیک یک ردیف می‌نویسد، `user-agent` و `referer` بدون سقف طول؛ مقصد فقط با `z.string().url()` اعتبارسنجی می‌شود (`javascript:`/`ftp:` رد نمی‌شود) | `app/r/[slug]/route.ts`، `app/api/automations/route.ts:60,123` |
| F13 | متوسط | سخت‌سازی Docker/وب: کانتینرها root؛ `.env` کامل به همهٔ سرویس‌ها (cron هم `ENCRYPTION_KEY` دارد)؛ بدون هدرهای امنیتی؛ `/api/health` عمومی و پیام خام خطای DB/Redis را برمی‌گرداند | `Dockerfile`، `docker-compose.yml`، `Caddyfile`، `next.config.ts`، `app/api/health/route.ts` |
| F14 | متوسط | آپلود رسانه: کل فایل قبل از بررسی حجم در حافظه خوانده می‌شود؛ سهمیه‌ای برای workspace نیست | `app/api/media/route.ts:44-50` |
| F15 | متوسط | رمزنگاری: یک کلید ثابت بدون نسخه یا مسیر چرخش؛ توکن Graph API در بسیاری از فراخوانی‌ها در query string است | `lib/meta/oauth.ts:121-145`، `lib/meta/client.ts:490+` |
| F16 | پایین | مقایسهٔ Bearer در cron غیرثابت‌زمان؛ در صورت نبود هر دو secret مقدار `Bearer undefined` پذیرفته می‌شود؛ fallback به `NEXTAUTH_SECRET` | `app/api/cron/*/route.ts` |
| F17 | پایین | JWT سی‌روزه؛ با تغییر رمز یا حذف عضویت باطل نمی‌شود (کاربر حذف‌شده باطل می‌شود) | `lib/auth.ts` |
| F18 | پایین | افزودن کاربر موجود به workspace بدون پذیرش او | `app/api/workspace/members/route.ts:125-140` |
| F19 | پایین | state در OAuth Meta به نشست متصل نیست و ده دقیقه قابل تکرار است (اثر عملی کم؛ callback عضویت را چک می‌کند) | `lib/meta/oauth.ts:41-67` |
| F20 | پایین | پاسخ 404 در برابر 401 در webhook Zernio وجود workspace را لو می‌دهد؛ پنجرهٔ replay زمانی ندارد (idempotency جبران می‌کند) | `app/api/zernio/webhook/[workspaceId]/route.ts` |
| F21 | پایین | رویداد `read` در webhook بدون محدودیت workspace/provider روی `dmLog` جستجو می‌کند | `lib/queue/process-webhook.ts:151-165` |
| F22 | پایین | `scrypt` با ۶۴ مگابایت برای هر تلاش ورود؛ با جعل IP فشار حافظه روی VPS یک‌گیگابایتی | `lib/users/password.ts` |
| F23 | پایین | تصویر runner شامل devDependencies و کل `node_modules`؛ مدل `ProcessedComment` بلااستفاده | `Dockerfile`، `prisma/schema.prisma` |

## جزئیات و راه‌حل پیشنهادی

### F1 (بالا): نشت توکن دعوت‌نامه
`getMemberPayload` توکن و `inviteUrl` همهٔ دعوت‌های PENDING را برمی‌گرداند و `GET` هیچ نقشی را چک نمی‌کند. `createInvitedUser` با داشتن توکن، حساب با ایمیل مدعو و نقش دعوت (حتی ADMIN) می‌سازد. یک MEMBER می‌تواند قبل از مدعو حساب او را بسازد.
**راه‌حل:** توکن فقط به OWNER/ADMIN برگردد (بهتر: فقط یک‌بار هنگام ساخت نمایش داده شود و در DB به‌صورت hash ذخیره شود).

### F2 (بالا): تصاحب نصب تازه
تا اولین کاربر ساخته نشود، هر کسی که آدرس را بداند مالک می‌شود. نصب پیش‌فرض (حالت ۱) فوراً یک آدرس trycloudflare عمومی می‌سازد.
**راه‌حل:** متغیر `SETUP_TOKEN` الزامی برای `/setup`، یا ساخت مالک با CLI (`scripts/`) و غیرفعال‌سازی `/setup`. در استقرار ما: اول فقط `127.0.0.1`، ساخت مالک، بعد انتشار دامنه.

### F3 (بالا): زنجیرهٔ تأمین
compose پیش‌فرض `ghcr.io/arminshirzad/pasokh:latest` را می‌کشد و installer فایل‌ها را از شاخهٔ `main` بالادستی دانلود می‌کند. یعنی کد اجراشده همان فورک ما نیست و هر push بالادستی بدون بازبینی روی سرور می‌آید. `cloudflared:latest` و `caddy:2` هم pin نیستند.
**راه‌حل:** ساخت ایمیج از فورک (CI روی `exwarden/pasokh`)، `PASOKH_IMAGE` با digest، استقرار با `git clone` و `docker compose`، بدون `curl | bash`. نسخهٔ سرویس‌ها pin شود.

### F4 (بالا): وابستگی‌ها
`npm audit`: ۲۸ مورد (۴ critical، ۱۶ high). مستقیم و production: `next` (شامل bypass در Proxy با Turbopack و DoS در Server Actions)، `next-auth`/`@auth/core`/`@auth/prisma-adapter`، `zod` (<4.6.6)، `nodemailer` (نیاز به major 10.2.1، فقط وقتی `EMAIL_SERVER` تنظیم باشد)، `prisma`. اثر `proxy.ts` محدود است چون `proxy.ts` فقط ریدایرکت اولیه می‌کند و احراز هویت واقعی در layout و route handlerها انجام می‌شود، اما این را باید پس از ارتقا با تست تأیید کرد.
**راه‌حل:** ارتقا با `npm audit fix` (بدون `--force`)، سپس بررسی جداگانهٔ nodemailer؛ تست کامل بعد از ارتقا.

### F5 (بالا): ارسال انبوه SMS
`createSmsCampaign` گیرندگان را می‌گیرد، کمپین می‌سازد و همان لحظه job را صف می‌کند. فقط رابط کاربری می‌تواند پیش‌نمایش بدهد. دو بار فرستادن یک درخواست دو کمپین می‌سازد. گیرنده‌ها شامل مخاطبان حساب SIMULATOR (آزمایشگاه) هم می‌شوند اگر `accountId` خالی باشد. فیلد رضایت یا لغو عضویت در `Contact` وجود ندارد.
نقاط مثبت: حالت TEST، توقف کمپین در خطای نامشخص (`UNCONFIRMED`)، claim اتمیک دسته‌ها.
**راه‌حل:** مرحلهٔ تأیید دو‌مرحله‌ای (preview با تعداد و توکن یک‌بارمصرف)، سقف `SMS_MAX_RECIPIENTS` و سقف روزانه، ضد تکرار (hash پیام + فیلتر در ۲۴ ساعت)، حذف حساب‌های SIMULATOR، فیلد `smsConsent`.

### F6 (متوسط): محدودیت ورود
`clientIp` اول `cf-connecting-ip` و بعد `x-forwarded-for` را می‌خواند. پشت Caddy (پروفایل domain) و بدون Cloudflare، مهاجم این هدرها را خودش می‌فرستد و سقف ۲۰ در IP بی‌اثر می‌شود. سقف ایمیل (۵) باقی می‌ماند، که خودش راهی برای قفل‌کردن مالک است.
**راه‌حل:** متغیر `TRUSTED_PROXY` و استفاده از هدر مطمئن همان پروفایل، کلید ترکیبی ایمیل+IP برای قفل، تأخیر تصاعدی به‌جای قفل کامل.

### F7 (متوسط): SSRF در AI
`baseUrl` فقط `url()` است؛ `http://redis:6379`، `http://web:3000`، `http://169.254.169.254/` پذیرفته می‌شود. فقط OWNER/ADMIN تنظیم می‌کند، اما `/api/ai/test` (بدون چک نقش) تا ۲۰۰ نویسهٔ `error.message` پاسخ را برمی‌گرداند.
**راه‌حل:** فقط `https:`، حل DNS و رد محدوده‌های خصوصی/link-local، چک نقش در `/api/ai/test`، محدودیت نرخ.

### F8 (متوسط): کنترل AI
- سقف روزانه فقط `status: SENT` را می‌شمارد؛ هر پیام ورودی یک فراخوانی پولی می‌سازد، حتی اگر ارسال بعدی شکست بخورد.
- سقف سراسری یا بودجهٔ workspace وجود ندارد.
- تزریق پرامپت: قوانین در system prompt هستند و پیام مشتری فقط نقش user دارد (خوب)، اما هیچ فیلتر خروجی نیست. برای املاک لوکس و تبلیغات محیطی خطر اصلی «قیمت یا موجودی ساختگی» است.
- حریم خصوصی: به مدل فقط متن پیام، تاریخچهٔ همان فرستنده و `@username` حساب می‌رود؛ `igsid` نمی‌رود. اگر مشتری شماره یا نام بنویسد، همان به API ثالث می‌رود.
- شکست API: `FAILED` ثبت می‌شود و مشتری بی‌پاسخ می‌ماند؛ هشدار یا واگذاری به انسان نیست.
**راه‌حل:** شمارش تلاش‌ها، سقف سراسری، فیلتر خروجی (الگوی قیمت/ارقام/لینک خارج از دانش‌نامه)، پیام ثابت واگذاری به انسان و رویداد `OperationalEvent` در شکست.

### F9 (متوسط): نقش‌ها
فقط مسیرهای حساس (اتصال اینستاگرام، تنظیمات AI/SMS، کمپین‌ها، اعضا) `canManageWorkspace` دارند. بقیه فقط ورود می‌خواهند. **این تصمیم محصولی است:** اگر MEMBER قرار است «اپراتور پشتیبانی» باشد، ارسال DM از inbox معقول است؛ حذف فرم/دستور/ویترین و ویرایش مخاطب معقول نیست.
**نیاز به تصمیم شما.**

### F10 تا F23
راه‌حل هر مورد در ستون یافته مشخص است و تفکیک کامل‌تر آن در فاز ۲ در صورت تأیید می‌آید. موارد مهم: F11 (job پاک‌سازی با مدت نگهداری قابل‌تنظیم، مثلاً ۹۰ روز برای `WebhookEvent`)، F12 (فقط http/https، سقف طول هدرها، rate limit روی `/r/`)، F13 (`USER node`، env جدا برای cron، هدرهای HSTS/`X-Content-Type-Options`/`frame-ancestors` در Caddy)، F15 (پیشوند نسخهٔ کلید و اسکریپت re-encrypt، انتقال توکن به هدر Authorization).

## نقاط قوتی که تأیید شد

- امضای webhook متا روی بدنهٔ خام، با `timingSafeEqual`؛ امضای Zernio با regex و مقایسهٔ ثابت‌زمان.
- idempotency مستحکم: `DmLog @@unique([automationId, commentId])`، `PostbackDelivery`، `ConversationSession`، `AiReply @@unique`؛ jobId قطعی. خطای ارسال مبهم هرگز خودکار تکرار نمی‌شود.
- توکن‌ها با AES-256-GCM، IV تصادفی، برچسب احراز؛ کلید API هرگز به مرورگر برنمی‌گردد.
- همهٔ کوئری‌های مسیرهای بررسی‌شده با `workspaceId` محدود شده‌اند (الگوی `findFirst({ id, workspaceId })`)؛ موردی از دسترسی بین-workspace پیدا نشد.
- هیچ `dangerouslySetInnerHTML` یا `innerHTML` در کد نیست؛ React متن مشتری را escape می‌کند.
- ریدایرکت `callbackUrl` فقط مسیر داخلی می‌پذیرد؛ آدرس `authUrl` زرنیو با فهرست دامنه‌ها چک می‌شود.
- خروجی CSV در برابر formula injection محافظت شده است. آپلود رسانه نوع را از بایت‌های ابتدایی تشخیص می‌دهد و `nosniff` می‌فرستد.
- ورود: زمان ثابت برای کاربر ناموجود (dummy hash)، قفل مشورتی (advisory lock) برای ساخت اولین مالک.
- Postgres و Redis در compose روی پورت میزبان باز نیستند؛ پورت وب پیش‌فرض `127.0.0.1` است.

## تصمیم‌های لازم از شما

1. **F9:** نقش MEMBER چه کارهایی بتواند بکند؟ (پیشنهاد: فقط inbox، مشاهده، و ویرایش مخاطب؛ بقیه ADMIN.)
2. **F5:** سقف پیش‌فرض SMS در هر کمپین و روز؟ و آیا فیلد رضایت (opt-in) اضافه شود؟
3. **F2:** روش ساخت مالک در سرور: `SETUP_TOKEN` یا CLI؟
4. **F3:** رجیستری ایمیج: `ghcr.io/exwarden` یا ساخت مستقیم روی VPS؟
5. **F4:** ارتقای `next-auth` بتا ممکن است رفتار را تغییر دهد؛ تأیید شما برای ارتقا با تست کامل.

## اولویت پیشنهادی برای فاز ۲

F1، F2، F4، F5، F3 (راه‌اندازی build/pin)، سپس F6، F7، F8، F9. بقیه گروه‌بندی می‌شوند. هر مورد در کامیت جدا و در صورت امکان با تست.
