# DEPLOYING THE LOGMAS BACKEND

> Deploy target in the notes below: a cPanel/WHM shared-hosting box running
> Passenger, with the app checked out under `~/repositories/<app-name>`.

## 1. Authenticate with GitHub

Do **not** paste a personal access token into the remote URL — that leaks it
into `.git/config`, shell history, and any committed file. Use an SSH remote
(recommended) or a credential helper:

```bash
# Preferred: SSH
git remote set-url origin git@github.com:MigrationGFA/logmas-back-ijebu-north.git

# Or HTTPS with a credential manager (prompts, stores the token in the OS vault)
git remote set-url origin https://github.com/MigrationGFA/logmas-back-ijebu-north.git
git fetch origin
```

If a token was ever pasted into a URL, **revoke it on GitHub immediately**
(Settings → Developer settings → Personal access tokens) and issue a new one.

## 2. Pull the code

```bash
git pull origin main
```

## 3. Install dependencies

```bash
npm install
```

## 4. Sync the database schema and refresh the Prisma client types

```bash
npx prisma db push
npx prisma generate
```

For a production database use the migration workflow instead:

```bash
npm run prisma:deploy
```

## 5. Load the service catalog (seed)

```bash
npx prisma db seed
```

The seed reads `prisma/data/<LGA_ID>.services.json` and upserts both the
`services` rows and their fee rows. Expected tail:

```
✅ <LGA Name> (<lga-id>) services and service fees seeded successfully
```

Re-running the seed is safe — it upserts by `code`, so it updates existing
services instead of duplicating them. See "ADDING OR CHANGING A SERVICE" in
`LGA_ONBOARDING_BACKEND.md`.

## 6. Compile and restart

```bash
npm run build
pkill -u getfjupm node   # let Passenger boot the fresh build
```

## 7. Environment

Copy `.env.example` to `.env` and fill in real values. **Never commit `.env`** —
it is already in `.gitignore`. Each LGA needs its own:

- `DATABASE_URL` (a database that belongs to this LGA only)
- `LGA_ID` / `LGA_NAME` / `LGA_FULL_NAME` / `LGA_SHORT_CODE` / `LGA_ACCOUNT_PREFIX`
- `FRONTEND_URL` / `BACKEND_URL` / `API_BASE_URL`
- `GPAY_*` merchant credentials for this LGA

Never reuse another LGA's database, merchant credentials, or webhook secret.
