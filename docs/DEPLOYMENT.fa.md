# استقرار روی سرور (فورک exwarden/pasokh)

این سند روند استقرار ما را ثبت می‌کند. از installer پیش‌فرض (`curl | bash`) و تونل عمومی سریع استفاده نمی‌کنیم.

## ۱. ساخت مالک: اول فقط روی 127.0.0.1

صفحهٔ `/setup` تا اولین حساب ساخته نشود برای هر کسی که به آن برسد باز است. برای همین:

1. در `.env` مقدار `SETUP_TOKEN` را (دست‌کم ۱۶ نویسه، تصادفی) بگذارید. بدون آن `/setup` قفل است:
   ```bash
   openssl rand -hex 16
   ```
2. `COMPOSE_PROFILES` را **خالی** بگذارید و `PASOKH_BIND=127.0.0.1` را تغییر ندهید. در این حالت برنامه فقط روی خود سرور در دسترس است: نه تونل، نه Caddy، نه پورت ۸۰/۴۴۳.
3. از لپ‌تاپ تونل SSH بزنید و صفحه را باز کنید:
   ```bash
   ssh -L 3000:127.0.0.1:3000 user@SERVER_IP
   ```
   سپس `http://localhost:3000/setup` را باز کنید، `SETUP_TOKEN` را وارد کنید و حساب مالک را بسازید.
4. وارد شوید و بررسی کنید `/setup` اکنون به `/login` برمی‌گردد.
5. فقط بعد از این، دامنه را منتشر کنید: `COMPOSE_PROFILES=domain`، `PASOKH_DOMAIN` و `NEXTAUTH_URL=https://دامنه` را در `.env` بگذارید و `docker compose up -d` بزنید.

بعد از ساخت مالک، `/setup` برای همیشه بسته است؛ نگه‌داشتن `SETUP_TOKEN` در `.env` بی‌خطر است، ولی می‌توانید حذفش کنید.

اگر `SETUP_TOKEN` اشتباه وارد شود، شمارندهٔ مشترک پنج بار خطا را در ۱۵ دقیقه می‌پذیرد و بعد قفل می‌شود.

## ۲. ایمیج: ساخت از فورک خودمان

ایمیج فقط از `exwarden/pasokh` ساخته می‌شود (workflow «Publish image»)، نه از ایمیج بالادستی.

- روی push معمولی چیزی منتشر نمی‌شود. انتشار با تگ نسخه است. workflow انتشار اول CI کامل را اجرا می‌کند و اسکن Trivy (آسیب‌پذیری HIGH/CRITICAL قابل‌رفع) را پیش از تگ‌گذاری؛ اگر هرکدام شکست بخورد ایمیجی تگ نمی‌شود. موارد پذیرفته‌شده در `.trivyignore` با دلیل ثبت‌اند:
  ```bash
  git tag v0.2.0-mr.1 && git push origin v0.2.0-mr.1
  ```
- وقتی workflow تمام شد، در خلاصهٔ اجرا (Run summary → «Image digest») یک خط مثل این می‌آید:
  `PASOKH_IMAGE=ghcr.io/exwarden/pasokh@sha256:...`
- همین مقدار را در `.env` سرور بگذارید. `PASOKH_IMAGE` الزامی است و پیش‌فرض ندارد؛ تگ شناور (`:latest`، `:main`) استفاده نمی‌کنیم.
- بستهٔ ghcr را بعد از اولین انتشار private نگه دارید و برای VPS یک توکن فقط‌خواندنی (`read:packages`) بسازید: `docker login ghcr.io`.
- بروزرسانی: digest جدید را در `.env` بگذارید و `docker compose pull && docker compose up -d` بزنید.

سرویس‌های جانبی (`postgres`, `redis`, `caddy`, `cloudflared`) و ایمیج پایهٔ `node` در `docker-compose.yml` و `Dockerfile` با digest ثابت شده‌اند. برای ارتقای آن‌ها digest جدید را عمداً جایگزین کنید:
```bash
docker buildx imagetools inspect caddy:2 --format '{{.Manifest.Digest}}'
```

Actionهای GitHub هم با SHA کامل ثابت شده‌اند (کنار هر خط نسخه‌ی اصلی در کامنت آمده است).

## ۳. استقرار روی VPS (بدون installer)

```bash
git clone https://github.com/exwarden/pasokh.git && cd pasokh
git checkout <تگ منتشرشده>
cp .env.example .env     # سپس رمزها را بسازید: openssl rand -hex 32
```

در `.env` مقدار این‌ها را بگذارید: `NEXTAUTH_SECRET`، `CRON_SECRET`، `ENCRYPTION_KEY`، `POSTGRES_PASSWORD`، `SETUP_TOKEN`، `PASOKH_IMAGE`. بعد مراحل بخش ۱ (ساخت مالک روی 127.0.0.1)، سپس انتشار دامنه.

`curl | bash` و تونل سریع کلودفلر استفاده نمی‌شوند. اسکریپت‌های `install.sh` و `install.ps1` فقط برای سازگاری با بالادستی نگه داشته شده‌اند.

**کانتینرها با کاربر `node` (غیر root) اجرا می‌شوند.** اگر قبلاً با ایمیج قدیمی (root) volume آپلودها ساخته شده، یک‌بار مالکیتش را درست کنید:
```bash
docker compose run --rm --user root --entrypoint chown web -R node:node /app/data
```

**از `.env` یک نسخهٔ پشتیبان جدا از سرور نگه دارید.** بدون `ENCRYPTION_KEY` توکن‌های ذخیره‌شده خوانده نمی‌شوند.

### چرخش `ENCRYPTION_KEY`

فقط با این روند (هرگز کلید را مستقیم عوض نکنید):

1. از دیتابیس و از `.env` نسخهٔ پشتیبان بگیرید.
2. کلید جدید بسازید (`openssl rand -hex 32`)؛ کلید قدیمی را در `ENCRYPTION_KEY_PREVIOUS` و کلید جدید را در `ENCRYPTION_KEY` بگذارید و `docker compose up -d` بزنید. برنامه با هر دو کلید می‌خواند و با کلید جدید می‌نویسد.
3. اول بدون تغییر ببینید چه چیزی روی کلید قدیمی است، بعد اعمال کنید:
   ```bash
   docker compose exec web npm run keys:rotate
   docker compose exec web npm run keys:rotate -- --apply
   ```
4. وقتی گزارش «0 on an old key» و «0 unreadable» داد، `ENCRYPTION_KEY_PREVIOUS` را حذف کنید.
