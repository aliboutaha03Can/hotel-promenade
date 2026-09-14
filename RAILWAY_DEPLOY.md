# Railway Deployment

This project can be deployed directly from this local folder with the Railway CLI.

## 1. Login and create a Railway project

```powershell
npx @railway/cli@latest login
npx @railway/cli@latest init
```

Follow the prompts in the terminal and browser.

## 2. Add required variables in Railway

In Railway, open the app service, go to **Variables**, and add:

```env
NODE_ENV=production
JWT_SECRET=generate-a-long-random-secret
BOOTSTRAP_ADMIN_EMAIL=admin@lapromenade.com
BOOTSTRAP_ADMIN_PASSWORD=choose-a-secure-admin-password
ENABLE_DEMO_USERS=false
DEMO_USER_PASSWORD=choose-a-secure-demo-password
HOTEL_BILLING_FROM_NAME=Hotel La Promenade
CONCIERGE_TIMEZONE=America/Toronto
```

Optional variables:

```env
GMAIL_USER=
GMAIL_APP_PASS=
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_CHAT_ID=
GEMINI_API_KEY=
GROQ_API_KEY=
```

Do not add `PORT`; Railway provides it automatically.

## 3. Add persistent storage for SQLite and uploads

Create a Railway volume for the app service and set its mount path to:

```text
/data
```

The app automatically uses Railway's `RAILWAY_VOLUME_MOUNT_PATH` variable. With the volume mounted, SQLite will live at `/data/database.db` and uploads will live under `/data/uploads`.

## 4. Deploy

From this project folder:

```powershell
npx @railway/cli@latest up
npx @railway/cli@latest domain
```

The `domain` command creates a public Railway URL for the app.

## 5. After deployment

Open the public URL and sign in with:

```text
Email: the BOOTSTRAP_ADMIN_EMAIL value
Password: the BOOTSTRAP_ADMIN_PASSWORD value
```

If the deploy fails, open the Railway deployment logs first. The most common causes are missing `JWT_SECRET`, missing bootstrap password, or no volume attached for persistent data.
