# BACKEND LGA ONBOARDING (`logmas-back-odeda`)

> Backend half of the LGA swap. The canonical, end-to-end guide lives in the
> frontend repo: `logmas-odeda/LGA_CLONE_AND_ONBOARDING_GUIDE.md` (Part 0
> covers the deployment topology — one LGA = one backend instance = one
> database; code is shared, instances never are).

## 1. `.env` (copy from `.env.example`)

```dotenv
# LGA identity — the seed and all payment/notification labels read these
LGA_ID=kosofe
LGA_NAME=Kosofe
LGA_SHORT_CODE=KOS
LGA_ACCOUNT_PREFIX=KOSOFE

# Fresh database per LGA
DATABASE_URL=postgresql://user:password@localhost:5432/logmas_kosofe

# Domains
FRONTEND_URL=https://www.kosofe.example
BACKEND_URL=https://api.kosofe.example
API_BASE_URL=https://api.kosofe.example/api/v1

# This LGA's own GPay merchant
GPAY_BASE_URL=...
GPAY_API_KEY=...
GPAY_AUTH_SECRET=...
GPAY_WEBHOOK_SECRET=...
GPAY_WEBHOOK_URL=https://api.kosofe.example/api/v1/payments/gpay/webhook
GPAY_RETURN_URL=https://www.kosofe.example
```

Never reuse another LGA's database, merchant credentials, or webhook secret.

## 2. Services catalog

Drop your catalog at `prisma/data/<LGA_ID>.services.json`. Format:
`prisma/data/odeda.services.json`. Descriptions may use `{lgaName}` /
`{lgaFullName}` tokens — the seed interpolates them from `LGA_NAME`.

## 3. Migrate + seed

```bash
npm install
npm run prisma:migrate     # applies schema to the fresh DB
npx prisma db seed         # loads prisma/data/<LGA_ID>.services.json
```

Expected tail: `✅ Kosofe (kosofe) services and service fees seeded successfully`.

## 4. Optional: register a preset

`src/config/lga.config.ts` holds presets for known LGAs (env vars always win).
Adding your LGA there keeps the identity in version control:

```ts
const LGA_PRESETS = {
  odeda: { ... },
  kosofe: { id: "kosofe", name: "Kosofe", fullName: "Kosofe Local Government",
            shortCode: "KOS", accountPrefix: "KOSOFE" },
};
```

With a preset in place, `LGA_ID=kosofe` alone is enough — the other LGA_*
env vars become optional overrides.

## 5. Runtime data (not code)

- **Wards**: create via the LGA-admin dashboard (`AddWardDialog`) — keep the
  list in sync with the frontend `lga.config.ts` wards.
- **Admin/treasurer users**: created through the dashboard or an invite flow.
- **Fee adjustments**: treasury dashboard (overrides the seeded defaults).

## 6. Verify the swap

```bash
LGA_ID=kosofe LGA_NAME=Kosofe node scripts/check-lga-swap.mjs
npx tsc --noEmit      # no NEW errors vs baseline
```

The lint scans `src/` and `prisma/` (excluding historical migrations and the
preset file) for any other LGA's name/slug — including in the services JSON.

## Where LGA-specific behaviour lives

| Concern | File |
|---|---|
| Identity labels (payment refs, payer defaults) | `src/config/lga.config.ts` (used by `gpay.controller.ts`) |
| Notification/email/SMS branding | `src/config/notification.template.ts` (`lgaName`) |
| Services + fees seed | `prisma/data/<LGA_ID>.services.json` + `prisma/seed.ts` |
| Invoice neutral defaults | `prisma/schema.prisma` (`virtualBankName` default is LGA-neutral) |
