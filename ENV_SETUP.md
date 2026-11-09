# LOGMAS Backend: Environment Variables

This backend is hosted on **cPanel** (Node.js app). Set these variables in
cPanel under **Software > Setup Node.js App > Environment Variables** (or in a
`.env` file in the application root), then **restart the app** so it picks
them up. `PORT` is assigned by cPanel/Passenger automatically; do not set it.

This file lists variable NAMES and what they are for only. Never commit real
secret values to this repository.

## New or newly important with the Nov 5, 2026 Ifo port

| Variable | Notes |
| --- | --- |
| `GPAY_SECRET_KEY` | **Required.** The treasurer GPay Monitoring Hub calls fail without it. A hardcoded fallback that existed in the Ifo code was deliberately removed from this port; the key must come from here. |
| `STATUTORY_ACCOUNT_NUMBER` | **Required for demand notices.** Printed on demand notices and used as the statutory revenue account fallback. This LGA's own Providus account number. |
| `STATUTORY_ACCOUNT_NAME` | Account name matching the number above. |
| `STATUTORY_BANK_NAME` | Optional. Defaults to Providus Bank Plc. |
| `STATUTORY_BANK_CODE` | Optional. Defaults to 000023. |
| `APP_URL` | Public URL of this platform, used in demand notice email links. Falls back to `GPAY_RETURN_URL` when unset. |

## Core

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string for this LGA's database. |
| `JWT_SECRET` | Signs access tokens (1 day). |
| `JWT_REFRESH_SECRET` | Signs refresh tokens (7 days). |
| `NODE_ENV` | Set to `production` on the server. |

## Platform URLs

| Variable | Notes |
| --- | --- |
| `FRONTEND_URL` | Public URL of the Vercel frontend (CORS and links). |
| `BACKEND_URL` | Public URL of this API on cPanel. |
| `API_BASE_URL` | API base used in generated links, ends with `/api/v1`. |

## This LGA's identity

| Variable | Value for this platform |
| --- | --- |
| `LGA_ID` | `ijebu-north-east` |
| `LGA_NAME` | `Ijebu North East` |
| `LGA_FULL_NAME` | This LGA's full official name |
| `LGA_SHORT_CODE` | `INE` |
| `LGA_ACCOUNT_PREFIX` | `IJEBUNORTHEAST` |

## GPay gateway

| Variable | Notes |
| --- | --- |
| `GPAY_API_KEY` | Gateway API key. |
| `GPAY_SECRET_KEY` | See the Nov 5 section above. |
| `GPAY_AUTH_SECRET` | Gateway auth secret. |
| `GPAY_WEBHOOK_SECRET` | Verifies webhook signatures. |
| `GPAY_WEBHOOK_URL` | Public webhook endpoint for this API. |
| `GPAY_RETURN_URL` | Where payers land after checkout. |
| `GPAY_BASE_URL` | Optional. Defaults to https://gpay.gfa-tech.com/api/v1 |
| `GPAY_TIMEOUT_MS` | Optional gateway timeout. |
| `GPAY_USE_DIRECT_CHECKOUT` | Optional checkout mode flag. |
| `GPAY_DYNAMIC_ACCOUNT_EXPIRY_MINUTES` | Legacy. The dynamic account flow was removed in the Nov 5 port; harmless if left set. |

## Paystack

| Variable | Notes |
| --- | --- |
| `PAYSTACK_SECRET_KEY` | Paystack secret key for card payments. |
| `PAYSTACK_CALLBACK_URL` | Payment completion callback URL. |

## Email (SMTP) and SMS

| Variable | Notes |
| --- | --- |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_NAME` | Mailer used for receipts, demand notices and notifications. |
| `TERMII_API_KEY`, `TERMII_SENDER_ID` | SMS sending via Termii. |
| `TERMII_BASE_URL`, `TERMII_CHANNEL` | Optional Termii overrides. |
| `GOOGLE_CLIENT_ID` | Google sign-in client id; must match the frontend's `NEXT_PUBLIC_GOOGLE_CLIENT_ID` project. |

## Test only (leave unset in production)

`NOTIFICATION_TEST_MODE`, `TEST_RECIPIENT_EMAIL`, `TEST_RECIPIENT_PHONE`
