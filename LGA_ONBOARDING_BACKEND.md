# BACKEND LGA ONBOARDING

> Backend half of the LGA swap. The canonical, end-to-end guide lives in the
> frontend repo: `logmas-ijebu-north/LGA_CLONE_AND_ONBOARDING_GUIDE.md` (Part 0
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
`prisma/data/services.template.json`. Descriptions may use `{lgaName}` /
`{lgaFullName}` tokens — the seed interpolates them from `LGA_NAME`.

## 2a. ADDING OR CHANGING A SERVICE

The catalog file is the single source of truth for the services and fees shown
to citizens. Editing it and re-running the seed is all that is required.

**To add a service:** append an object to the JSON array in
`prisma/data/<LGA_ID>.services.json`:

```json
{
  "code": "tenement_rate",
  "certificateType": "TENEMENT_RATE_CLEARANCE",
  "name": "Tenement Rate",
  "description": "Assessment and levy on property holdings located in {lgaFullName}.",
  "category": "RATES_AND_LEVIES",
  "revenueHead": "2001 - Tenement & Property Rates",
  "requirements": ["previous_receipt", "owner_id", "title_document", "building_photos"],
  "estimatedDays": 14,
  "fee": 25000
}
```

Field rules:

| Field | Rule |
|---|---|
| `code` | Stable, unique, `snake_case`. This is the upsert key — never change it after launch or a second service is created. |
| `certificateType` | Must be a value of the Prisma `CertificateType` enum (see `prisma/schema.prisma`). `CLUB_REGISTRATION`, `CDA_REGISTRATION` and `CERTIFICATE_OF_ORIGIN` all work; pick the closest match. |
| `category` | Must be a `ServiceCategory` enum value: `CERTIFICATE`, `RATES_AND_LEVIES`, `LICENCES_AND_PERMITS`, `URBAN_DEVELOPMENT`. |
| `description` | May use the `{lgaName}` / `{lgaFullName}` tokens; they are interpolated from the `LGA_*` env vars at seed time. |
| `revenueHead` | Treasury revenue head. Keep the numbering scheme consistent with the other rows. |
| `requirements` | Document requirement keys (see the frontend requirement map for valid keys). |
| `estimatedDays` | Integer processing days. |
| `fee` | Default fee in NGN (whole naira). The treasury can override it live in the dashboard. |

**To change a service:** edit its object in the same file (e.g. change `fee`,
`name`, `estimatedDays`) and re-run the seed. The seed upserts by `code`, so
the existing row is updated in place — the service `id` and every
`Application`/`Invoice` already attached to it stay valid.

**To retire a service:** remove it from the JSON and re-run the seed. Note
that the seed only touches rows it knows about, so the service row itself
remains in the database. Deactivate it instead of deleting it — the
`Service.isActive` flag (or the treasury dashboard's deactivate action) keeps
historical applications and certificates readable. Deleting the row outright
breaks those references.

**To re-seed:**

```bash
npx prisma db seed
```

It is idempotent — safe to run as many times as you like. It upserts the
`Service` rows and their `ServiceFeeConfig` (fee) rows by `code` /
`serviceId`, so nothing is duplicated. Only the services listed in the JSON
file are touched.

**Keep the frontend in sync:** the frontend's tariff defaults live separately
in `src/config/services.config.ts`. If the new LGA's schedule differs from
the template, update both so the fee shown before payment matches the fee
charged.

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
  "ijebu-north-east": { ... },
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
