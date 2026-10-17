// src/modules/payment/gpay.service.ts
//
// Core GPay (Mastercard MPGS) wrapper — schema-independent. Handles talking to
// GPay's API only. Wiring this to Invoice / Payment / PaymentIntent rows happens
// in gpay.controller.ts.
//
// Merchant: per-deployment (configured via GPAY_* env vars — see src/config/env usage in gpay.service)
// Gateway base: https://gpay.gfa-tech.com/api/v1
//
// Notable differences from Paystack that this file has to absorb:
//   * amounts are decimal NGN, NOT kobo (no *100 anywhere)
//   * verify takes a query param, not a path param
//   * the webhook is HMAC-SHA256 with a dedicated webhook secret (not the API key)
//   * GPay echoes NO metadata, so callers must persist their own context
//     (see PaymentIntent in prisma/schema.prisma)

import crypto from "crypto";

const GPAY_BASE_URL = (
  process.env.GPAY_BASE_URL?.trim() || "https://gpay.gfa-tech.com/api/v1"
).replace(/\/+$/, "");

// Bearer token sent on every call. GPAY_AUTH_SECRET is the documented
// `authorization_secret`; we fall back to the merchant API key in case the two
// turn out to be the same value for this merchant.
const GPAY_AUTH_SECRET =
  process.env.GPAY_AUTH_SECRET?.trim() || process.env.GPAY_API_KEY?.trim();

// Separate secret used only to verify inbound webhook signatures.
const GPAY_WEBHOOK_SECRET =
  process.env.GPAY_WEBHOOK_SECRET?.trim() || undefined;

// GPay returns two checkout links: the raw Mastercard MPGS hosted page
// (`checkout_url`) and GPay's own wrapper page (`gpay_checkout_url`). We default
// to GPay's page because that is the one wired to honour the `return_url` we
// send. Flip GPAY_USE_DIRECT_CHECKOUT=true to use the MPGS link instead.
const USE_DIRECT_MPGS_CHECKOUT = process.env.GPAY_USE_DIRECT_CHECKOUT === "true";

const GPAY_TIMEOUT_MS = Number(process.env.GPAY_TIMEOUT_MS ?? 30_000);

if (!GPAY_AUTH_SECRET) {
  console.warn(
    "[gpay.service] GPAY_AUTH_SECRET / GPAY_API_KEY is not set — GPay calls will fail.",
  );
} else if (!process.env.GPAY_AUTH_SECRET?.trim()) {
  console.warn(
    "[gpay.service] GPAY_AUTH_SECRET is not set — falling back to GPAY_API_KEY. Note: " +
      "the merchant API key alone returned 401 on GPay's endpoints during testing, so set " +
      "GPAY_AUTH_SECRET to the bearer token GPay actually accepts.",
  );
}
if (!GPAY_WEBHOOK_SECRET) {
  console.warn(
    "[gpay.service] GPAY_WEBHOOK_SECRET is not set — webhook signature verification will always fail.",
  );
}

// ── URLs ──────────────────────────────────────────────────────

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Where the payer lands after finishing (or abandoning) the hosted page. */
export const gpayReturnUrl = `${trimSlash(
  process.env.GPAY_RETURN_URL ??
    process.env.FRONTEND_URL ??
    "http://localhost:3002",
)}/payment/result`;

/**
 * Where GPay should POST the payment notification. Must be publicly reachable
 * (use ngrok/a tunnel while developing locally).
 */
export const gpayWebhookUrl = (() => {
  const explicit = process.env.GPAY_WEBHOOK_URL;
  if (explicit) return explicit;

  const base = process.env.API_BASE_URL ?? process.env.BACKEND_URL;
  if (base) return `${trimSlash(base)}/api/v1/payments/gpay/webhook`;

  console.warn(
    "[gpay.service] GPAY_WEBHOOK_URL is not set — falling back to a localhost URL. GPay will not be able to reach this webhook; use the local simulator script.",
  );
  return "http://localhost:3004/api/v1/payments/gpay/webhook";
})();

// ── Status normalisation ──────────────────────────────────────

/**
 * GPay reports transaction state inconsistently across its own endpoints
 * (`"successful"` on the webhook, `"SUCCESS"` inside the raw MPGS
 * `order_details` block, `"pending"` on verify). Everything is funnelled into
 * three buckets before any decision is made. Unknown values are treated as
 * "pending" — an unrecognised string is never treated as a successful payment.
 */
export type NormalizedStatus = "successful" | "failed" | "pending";

const SUCCESS_STATES = new Set([
  "successful",
  "success",
  "captured",
  "approved",
  "completed",
  "paid",
  "settled",
]);

const FAILED_STATES = new Set([
  "failed",
  "failure",
  "declined",
  "decline",
  "cancelled",
  "canceled",
  "expired",
  "voided",
  "reversed",
  "error",
  "abandoned",
  "timeout",
]);

export function normalizeGatewayStatus(value: unknown): NormalizedStatus {
  if (value === null || value === undefined) return "pending";
  const v = String(value).trim().toLowerCase();
  if (!v) return "pending";
  if (SUCCESS_STATES.has(v)) return "successful";
  if (FAILED_STATES.has(v)) return "failed";
  return "pending";
}

/**
 * GPay amounts arrive as decimal strings ("100.00"). Compare rounded to the
 * smallest unit so float representation can never cause a mismatch.
 */
export function sameAmount(a: unknown, b: unknown): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
  return Math.round(na * 100) === Math.round(nb * 100);
}

// ── Envelope helpers ──────────────────────────────────────────

/**
 * GPay replies with `{ status, response_code, message, data }` where
 * `response_code` is an ISO8583-style code ("00" = approved). Two different
 * fields are called "status": the top-level one describes the API call, while
 * `data.status` describes the transaction.
 */
export function isEnvelopeSuccess(json: any): boolean {
  if (!json || typeof json !== "object") return false;
  if (json.status !== "success") return false;
  if (json.response_code !== undefined && json.response_code !== null) {
    if (String(json.response_code) !== "00") return false;
  }
  return true;
}

function envelopeError(json: any, fallback: string): string {
  const message = json?.message ?? json?.error ?? fallback;
  const code =
    json?.response_code !== undefined && json?.response_code !== null
      ? ` (response_code: ${json.response_code})`
      : "";
  return `${message}${code}`;
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ── 1. Initiate checkout session ──────────────────────────────

export interface InitiateCheckoutParams {
  /** NGN, decimal. GPay expects Naira units — do NOT multiply by 100. */
  amount: number;
  currency?: string;
  /** Our own unique reference — sent as `merchant_transaction_ref`. */
  merchantTransactionRef: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  description?: string;
  returnUrl?: string;
  webhookUrl?: string;
}

export interface InitiateCheckoutData {
  transactionRef: string | null;
  merchantTransactionRef: string | null;
  orderId: string | null;
  amount: string | null;
  currency: string | null;
  status: NormalizedStatus;
  rawStatus: string | null;
  gatewayName: string | null;
  checkoutUrl: string | null;
  gpayCheckoutUrl: string | null;
  mastercardSessionId: string | null;
  sessionVersion: string | null;
  successIndicator: string | null;
  createdAt: string | null;
  raw: any;
}

export interface GpayResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  /** Raw gateway envelope, kept for auditing/storage. */
  raw?: any;
}

export async function initiateCheckout(
  params: InitiateCheckoutParams,
): Promise<GpayResult<InitiateCheckoutData>> {
  try {
    const res = await fetch(`${GPAY_BASE_URL}/mastercard/initiate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GPAY_AUTH_SECRET}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        amount: params.amount,
        currency: params.currency ?? "NGN",
        merchant_transaction_ref: params.merchantTransactionRef,
        customer_name: params.customerName,
        customer_email: params.customerEmail,
        customer_phone: params.customerPhone,
        description: params.description,
        return_url: params.returnUrl ?? gpayReturnUrl,
        webhook_url: params.webhookUrl ?? gpayWebhookUrl,
      }),
      signal: AbortSignal.timeout(GPAY_TIMEOUT_MS),
    });

    const json = await safeJson(res);

    if (!res.ok || !isEnvelopeSuccess(json)) {
      return {
        success: false,
        error: envelopeError(json, "Failed to initiate GPay checkout"),
        raw: json,
      };
    }

    const d = json?.data ?? {};

    return {
      success: true,
      raw: json,
      data: {
        transactionRef: d.transaction_ref ?? null,
        merchantTransactionRef: d.merchant_transaction_ref ?? null,
        orderId: d.order_id ?? null,
        amount: d.amount ?? null,
        currency: d.currency ?? null,
        status: normalizeGatewayStatus(d.status),
        rawStatus: d.status ?? null,
        gatewayName: d.gateway_name ?? null,
        checkoutUrl: d.checkout_url ?? null,
        gpayCheckoutUrl: d.gpay_checkout_url ?? null,
        mastercardSessionId: d.mastercard_session_id ?? null,
        sessionVersion: d.session_version ?? null,
        successIndicator: d.success_indicator ?? null,
        createdAt: d.created_at ?? null,
        raw: d,
      },
    };
  } catch (err: any) {
    console.error("[gpay.service] initiateCheckout error:", err?.message ?? err);
    return {
      success: false,
      error: err?.message ?? "GPay initiate request failed",
    };
  }
}

/** Picks which of the two checkout links to hand to the payer. */
export function pickCheckoutUrl(
  data: Pick<InitiateCheckoutData, "checkoutUrl" | "gpayCheckoutUrl">,
): string | null {
  if (USE_DIRECT_MPGS_CHECKOUT) {
    return data.checkoutUrl ?? data.gpayCheckoutUrl ?? null;
  }
  return data.gpayCheckoutUrl ?? data.checkoutUrl ?? null;
}

// ── 2. Verify transaction ─────────────────────────────────────

export interface CustomerDetails {
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface VerifyTransactionData {
  status: NormalizedStatus;
  rawStatus: string | null;
  /** True when either GPay's status or the raw MPGS verdict says paid. */
  isPaid: boolean;
  /** Raw MPGS `order_details.result`, e.g. "SUCCESS". */
  mpgsResult: string | null;
  amount: string | null;
  currency: string | null;
  gpayReference: string | null;
  orderId: string | null;
  merchantTransactionRef: string | null;
  gatewayName: string | null;
  gatewayReference: string | null;
  mastercardSessionId: string | null;
  customer: CustomerDetails | null;
  paidAtRaw: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  raw: any;
}

/**
 * A transaction counts as paid when EITHER signal says so.
 *
 * Observed on the sandbox: verify reported `status: "pending"` while the raw
 * MPGS block reported `order_details.result: "SUCCESS"` for the same
 * reference. Trusting `data.status` alone would leave genuinely paid invoices
 * unconfirmed (no receipt, citizen stuck, revenue unreconciled), so both are
 * accepted and the webhook / a later verify promotes the intent. This is the
 * single place to tighten once GPay confirms which field is authoritative.
 */
export function isPaidFromVerification(d: {
  rawStatus?: string | null;
  mpgsResult?: string | null;
}): boolean {
  return (
    normalizeGatewayStatus(d.rawStatus) === "successful" ||
    normalizeGatewayStatus(d.mpgsResult) === "successful"
  );
}

export async function verifyTransaction(
  merchantTransactionRef: string,
): Promise<GpayResult<VerifyTransactionData>> {
  try {
    const url = `${GPAY_BASE_URL}/mastercard/verify?merchant_transaction_ref=${encodeURIComponent(
      merchantTransactionRef,
    )}`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${GPAY_AUTH_SECRET}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(GPAY_TIMEOUT_MS),
    });

    const json = await safeJson(res);

    if (!res.ok || !isEnvelopeSuccess(json)) {
      return {
        success: false,
        error: envelopeError(json, "Failed to verify GPay transaction"),
        raw: json,
      };
    }

    const d = json?.data ?? {};
    const mpgsResult: string | null =
      d?.order_details?.result ?? d?.result ?? null;
    const rawStatus: string | null = d.status ?? null;

    return {
      success: true,
      raw: json,
      data: {
        status: normalizeGatewayStatus(rawStatus),
        rawStatus,
        isPaid: isPaidFromVerification({ rawStatus, mpgsResult }),
        mpgsResult,
        amount: d.amount ?? null,
        currency: d.currency ?? null,
        gpayReference: d.gpay_reference ?? d.transaction_ref ?? null,
        orderId: d.order_id ?? null,
        merchantTransactionRef: d.merchant_transaction_ref ?? null,
        gatewayName: d.gateway_name ?? null,
        gatewayReference: d.gateway_reference ?? null,
        mastercardSessionId: d.mastercard_session_id ?? null,
        customer: d.customer
          ? {
              name: d.customer.name ?? null,
              email: d.customer.email ?? null,
              phone: d.customer.phone ?? null,
            }
          : null,
        paidAtRaw: d.paid_at ?? null,
        createdAt: d.created_at ?? null,
        updatedAt: d.updated_at ?? null,
        raw: d,
      },
    };
  } catch (err: any) {
    console.error("[gpay.service] verifyTransaction error:", err?.message ?? err);
    return {
      success: false,
      error: err?.message ?? "GPay verify request failed",
    };
  }
}

// ── 3. Inbound webhook ────────────────────────────────────────

export interface GpayWebhookData {
  gpay_reference?: string;
  merchant_transaction_ref?: string;
  status?: string;
  amount?: string;
  currency?: string;
  gateway_name?: string;
  gateway_reference?: string | null;
  order_id?: string;
  mastercard_session_id?: string;
  paid_at?: string;
}

export interface GpayWebhookPayload {
  event?: string;
  data?: GpayWebhookData;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify that an inbound webhook really came from GPay.
 * GPay signs the raw request body with the webhook secret (HMAC) and sends it
 * as `X-GPay-Signature`.
 *
 * Two digests are accepted because GPay's docs and its live behaviour disagree:
 * the reserved-VA / checkout integrations were exercised with HMAC-SHA256,
 * while the dynamic-VA docs specify `hash_hmac('sha512', raw_payload, secret)`.
 * The four candidate digests have distinct lengths (sha256 hex=64 / base64=44,
 * sha512 hex=128 / base64=88), so there is never ambiguity between them, and
 * every comparison below is timing-safe. Tighten to the confirmed encoding
 * once GPay confirms it.
 *
 * IMPORTANT: this needs the *raw* request body bytes, not parsed JSON — see the
 * express.raw() note in gpay.routes.ts.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!GPAY_WEBHOOK_SECRET) return false;
  if (!signatureHeader) return false;
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;

  const provided = signatureHeader
    .trim()
    .replace(/^(sha256|sha512)=/i, "");
  if (!provided) return false;

  // One HMAC instance per digest — digest() can only be called once per instance.
  // Hex digests are compared case-insensitively; base64 is case-sensitive and
  // must be compared verbatim (lengths differ across algorithms, so a candidate
  // of the wrong length can never collide).
  const hexDigests = [
    crypto.createHmac("sha256", GPAY_WEBHOOK_SECRET).update(rawBody).digest("hex"),
    crypto.createHmac("sha512", GPAY_WEBHOOK_SECRET).update(rawBody).digest("hex"),
  ];
  const base64Digests = [
    crypto.createHmac("sha256", GPAY_WEBHOOK_SECRET).update(rawBody).digest("base64"),
    crypto.createHmac("sha512", GPAY_WEBHOOK_SECRET).update(rawBody).digest("base64"),
  ];

  const lowerProvided = provided.toLowerCase();
  return (
    hexDigests.some((d) => timingSafeStringEqual(lowerProvided, d)) ||
    base64Digests.some((d) => timingSafeStringEqual(provided, d))
  );
}

/** True when this is a payment event we should act on. */
export function isWebhookPaymentEvent(payload: GpayWebhookPayload): boolean {
  return payload?.event === "charge.success";
}

/**
 * Whether a webhook payload represents a settled payment.
 *
 * `event === "charge.success"` is the strongest signal available and GPay only
 * dispatches it once the transaction is settled on MPGS. We refuse to treat it
 * as paid only when the payload explicitly reports a failed/declined state, so
 * we can never record revenue that does not exist. Amount is still re-checked
 * against our stored intent in the controller.
 */
export function isWebhookPaid(payload: GpayWebhookPayload): boolean {
  if (!isWebhookPaymentEvent(payload)) return false;
  return normalizeGatewayStatus(payload?.data?.status) !== "failed";
}

// ── 4. Reserved virtual accounts (bank-transfer settlement) ──────────────
//
// GPay owns a pool of Providus Bank accounts, one per service. We resolve our
// `Service.code` to GPay's `service_code`, ask GPay which accounts exist, and
// hand the citizen exactly one account plus a fresh reference to quote in
// their transfer narration. The VA webhook carries NO narration, so that
// reference is for the bank statement; amount + account + createdAt are what
// actually match an inbound credit.

/**
 * GPay's `service_code` for each of our `Service.code` values.
 *
 * EXACT KEYS ONLY — never match on `service_name` and never pattern-match the
 * shape of a code (`TENEMENTR`, `MARKET_FEES` and friends are inconsistent).
 * Seeded from the live reserved-accounts response; a service missing here
 * simply has no account, which is the correct outcome.
 */
export const SERVICE_CODE_BY_SERVICE: Record<string, string> = {
  business_registration: "BIZREGIS",
  cda_registration: "CDAREGIST",
  club_registration: "CLUBREGIS",
  farmers_registration: "FARMREGIS",
  haulage_fees: "HAULAGEFE",
  kiosk_licence: "KIOSKLICN",
  liquor_licence: "LIQUORFEE",
  quarry_permit: "QUARRYPRM",
  sanitation_compliance: "ENVSANITN",
  state_of_origin: "ORIGINCER",
  street_naming: "STRTNAMNG",
  tenement_rate: "TENEMENTR",
  viewing_centre_licence: "VIEWCNTRL",
};

/** Our `Service.code` for an inbound GPay `service_code`, or null when unmapped. */
export function serviceCodeForGpay(serviceCode: unknown): string | null {
  if (typeof serviceCode !== "string") return null;
  const needle = serviceCode.trim();
  if (!needle) return null;
  for (const [ours, theirs] of Object.entries(SERVICE_CODE_BY_SERVICE)) {
    if (theirs === needle) return ours;
  }
  return null;
}

export interface ReservedVirtualAccount {
  accountNumber: string;
  accountName: string;
  bankName: string;
  serviceCode: string;
  status: string;
}

interface ReservedAccountsCache {
  fetchedAt: number;
  accounts: ReservedVirtualAccount[];
}

const RESERVED_ACCOUNTS_TTL_MS = 10 * 60 * 1000;
let reservedAccountsCache: ReservedAccountsCache | null = null;

/**
 * GPay's reserved virtual accounts — SERVER SIDE ONLY. The bearer token never
 * reaches a browser, and `total_settled` / `bank_code` / `created_at` are
 * dropped here so they can never be serialized to a client.
 *
 * Cached ~10 minutes; a failed refresh serves the stale list rather than
 * breaking the citizen's payment page. If we have never loaded the list the
 * error propagates and the caller returns 404 VIRTUAL_ACCOUNT_UNAVAILABLE.
 *
 * Path note: it is `/virtual-accounts/reserved` — the `/mastercard/` prefixed
 * variant in the integration notes returns 404 against the live gateway.
 */
export async function getReservedVirtualAccounts(
  opts: { forceRefresh?: boolean } = {},
): Promise<ReservedVirtualAccount[]> {
  const cache = reservedAccountsCache;
  const isFresh =
    !opts.forceRefresh &&
    cache !== null &&
    Date.now() - cache.fetchedAt < RESERVED_ACCOUNTS_TTL_MS;

  if (isFresh) return cache!.accounts;

  const res = await fetch(`${GPAY_BASE_URL}/virtual-accounts/reserved`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${GPAY_AUTH_SECRET}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(GPAY_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`GPay reserved accounts HTTP ${res.status}`);

  const body = (await res.json()) as {
    response_code?: string;
    data?: unknown;
  };

  if (body?.response_code !== "00") {
    throw new Error(
      `GPay reserved accounts rejected — response_code=${
        body?.response_code ?? "missing"
      }`,
    );
  }

  const accounts: ReservedVirtualAccount[] = [];
  for (const entry of Array.isArray(body.data) ? body.data : []) {
    const row = entry as Record<string, unknown>;
    const accountNumber = String(row?.account_number ?? "").trim();
    const serviceCode = String(row?.service_code ?? "").trim();
    if (!accountNumber || !serviceCode) continue;
    accounts.push({
      accountNumber,
      accountName: String(row?.account_name ?? "").trim(),
      bankName: String(row?.bank_name ?? "").trim(),
      serviceCode,
      status: String(row?.status ?? "").trim().toLowerCase(),
    });
  }

  reservedAccountsCache = { fetchedAt: Date.now(), accounts };
  return accounts;
}

/**
 * The ONE active reserved account for a GPay `service_code`, or null.
 * Two active accounts on one code is a data problem we refuse to guess at.
 */
export async function findReservedAccount(
  gpayServiceCode: string,
): Promise<ReservedVirtualAccount | null> {
  const accounts = await getReservedVirtualAccounts();
  const matches = accounts.filter(
    (a) => a.serviceCode === gpayServiceCode && a.status === "active",
  );

  if (matches.length === 0) return null;

  if (matches.length > 1) {
    console.error(
      `[gpay.service] service_code ${gpayServiceCode} resolved to ${matches.length} active accounts — refusing to pick one`,
    );
    return null;
  }

  return matches[0];
}

/**
 * GPay timestamps ("2026-09-28 14:30:00") carry no zone, and Node would read
 * that as SERVER local time. The gateway writes West Africa Time, so pull the
 * parts out ourselves and subtract Africa/Lagos (UTC+1, no DST) for UTC.
 */
export function parseLagosDateTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parts = value
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!parts) return null;

  const [, y, mo, d, h, mi, s] = parts;
  const utc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  return new Date(utc - 60 * 60 * 1000);
}

// ── 5. Reserved virtual account webhook dialect ──────────────────────────
//
// GPay posts TWO different shapes under the SAME `event: "charge.success"`.
// Always branch on the data, never on the event name.

export interface GpayReservedVaWebhookData {
  gpay_reference?: string;
  /** Providus's SETTLEMENT id — NOT one of our references. Never look it up. */
  providus_settlement_id?: string;
  providus_session_id?: string;
  /** Our reference never appears here either; there is no narration field. */
  merchant_transaction_ref?: string;
  status?: string;
  account_type?: string;
  amount_settled?: string;
  fee?: string;
  currency?: string;
  account_number?: string;
  paid_at?: string;
  service?: { service_code?: string; service_name?: string };
  payer_details?: {
    source_account_number?: string;
    source_account_name?: string;
    source_bank_name?: string;
    channel_id?: string;
  };
  [key: string]: unknown;
}

/** True when this payload is the reserved-VA dialect, not a checkout charge. */
export function isReservedVaWebhook(payload: unknown): boolean {
  const data = (payload as { data?: unknown } | null | undefined)?.data;
  if (!data || typeof data !== "object") return false;
  return (
    String((data as Record<string, unknown>).account_type ?? "").trim() ===
    "Reserved Virtual Account"
  );
}

export interface GpayDynamicVaWebhookData {
  /** "Dynamic Virtual Account" when GPay labels it; may be absent. */
  account_type?: string;
  /** OUR reference — we send it at creation, so it maps straight to an intent. */
  merchant_transaction_ref?: string;
  gpay_reference?: string;
  status?: string;
  amount?: string;
  /** Settled amount on the transfer; preferred over `amount` when present. */
  amount_settled?: string;
  currency?: string;
  account_number?: string;
  bank_name?: string;
  paid_at?: string;
  expires_at?: string;
  [key: string]: unknown;
}

/**
 * True when this payload is the dynamic-VA settlement dialect.
 *
 * ORDER MATTERS: the caller runs isReservedVaWebhook first, so by the time we
 * get here the reserved dialect is already excluded. Two signals:
 *   1. `account_type` names a dynamic account — definitive.
 *   2. No `account_type`, but OUR merchant_transaction_ref alongside a settled
 *      amount and no MPGS `order_details` block (checkout charges carry
 *      `order_details`; reserved VA was branched off already).
 *
 * A false positive costs only a "no PaymentIntent found" log — the lookup is
 * exact on our own unique reference, so nothing else can be touched.
 */
export function isDynamicVaWebhook(payload: unknown): boolean {
  const data = (payload as { data?: unknown } | null | undefined)?.data;
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;

  const accountType = String(d.account_type ?? "").trim().toLowerCase();
  if (accountType.includes("dynamic")) return true;
  if (accountType) return false; // some other labelled account type

  return Boolean(String(d.merchant_transaction_ref ?? "").trim()) &&
    (d.amount_settled !== undefined || d.amount !== undefined) &&
    d.order_details === undefined;
}

// ── 6. Dynamic virtual accounts (one-shot, short-lived bank transfer) ──────
//
// POST /virtual-accounts/dynamic mints a Providus account for ONE payment:
// GPay generates the account, the payer transfers the exact amount, and the
// settlement webhook (or a poll of GET /transactions/verify) closes the loop.
// Unlike the reserved pool this account EXPIRES (default 15 minutes), which is
// why PaymentIntent.expiresAt exists.

/** How long a dynamic account lives before GPay retires it. */
export const DYNAMIC_ACCOUNT_EXPIRY_MINUTES = Number(
  process.env.GPAY_DYNAMIC_ACCOUNT_EXPIRY_MINUTES ?? 15,
);

export interface CreateDynamicAccountParams {
  /** Label GPay shows on the account, e.g. "LGA-PREFIX/INV-0001". */
  accountName: string;
  /** NGN, decimal — same convention as initiateCheckout (no *100). */
  amount: number;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  /** Our own unique reference — sent as `merchant_transaction_ref`. */
  merchantTransactionRef: string;
  webhookUrl?: string;
  /** Defaults to DYNAMIC_ACCOUNT_EXPIRY_MINUTES (15). */
  expiryMinutes?: number;
}

export interface DynamicAccountData {
  accountNumber: string;
  accountName: string;
  bankName: string;
  /** Raw EMVCo NQR string, when GPay returns one. */
  qrCode: string | null;
  /** Vector SVG URL for the QR, when GPay returns one. */
  qrSvgUrl: string | null;
  /** Per-bank USSD dial strings keyed by bank name. */
  ussd: Record<string, string> | null;
  expiresAt: string | null;
  status: string | null;
  gpayReference: string | null;
  merchantTransactionRef: string | null;
  raw: any;
}

/** Reads the first present, non-empty field among several accepted spellings. */
function pickField(source: Record<string, unknown>, ...keys: string[]): any {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

/**
 * Mint a dynamic virtual account for a single payment.
 *
 * Fields are read defensively (snake_case plus a couple of aliases) because
 * GPay's reserved-account and dynamic-account responses disagree on naming.
 */
export async function createDynamicAccount(
  params: CreateDynamicAccountParams,
): Promise<GpayResult<DynamicAccountData>> {
  try {
    const res = await fetch(`${GPAY_BASE_URL}/virtual-accounts/dynamic`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GPAY_AUTH_SECRET}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        account_name: params.accountName,
        amount: params.amount,
        customer_name: params.customerName,
        customer_email: params.customerEmail,
        customer_phone: params.customerPhone,
        merchant_transaction_ref: params.merchantTransactionRef,
        webhook_url: params.webhookUrl ?? gpayWebhookUrl,
        expiry_minutes:
          params.expiryMinutes ?? DYNAMIC_ACCOUNT_EXPIRY_MINUTES,
      }),
      signal: AbortSignal.timeout(GPAY_TIMEOUT_MS),
    });

    const json = await safeJson(res);

    if (!res.ok || !isEnvelopeSuccess(json)) {
      return {
        success: false,
        error: envelopeError(json, "Failed to create dynamic virtual account"),
        raw: json,
      };
    }

    const d = (json?.data ?? {}) as Record<string, unknown>;

    // GPay's dynamic-account response NESTS the payment details under
    // `payment_channels`, and every channel value is an OBJECT (not a scalar):
    //   payment_channels.bank_transfer = { bank_name, bank_code, account_number,
    //                                       account_name, account_type }
    //   payment_channels.qr_code       = { qr_string, qr_image_url }
    //   payment_channels.ussd          = { ussd_code, ussd_template, bank_codes }
    // Read through payment_channels first, then fall back to top-level fields so
    // a flatter reserved-style payload still parses. `||` (not `??`) so an empty
    // string from one location falls through to the next.
    const channels = (d.payment_channels ?? {}) as Record<string, unknown>;
    const bankTransfer = (channels.bank_transfer ?? {}) as Record<string, unknown>;
    const qrChannel = (channels.qr_code ?? d.qr_code ?? {}) as Record<string, unknown>;
    const ussdChannel = (channels.ussd ?? d.ussd ?? {}) as Record<string, unknown>;

    const accountNumber = String(
      pickField(bankTransfer, "account_number", "accountNumber", "virtual_account_number") ||
        pickField(d, "account_number", "accountNumber", "virtual_account_number") ||
        "",
    ).trim();

    const accountName = String(
      pickField(bankTransfer, "account_name", "accountName") ||
        pickField(d, "account_name", "accountName") ||
        params.accountName ||
        "",
    ).trim();

    const bankName = String(
      pickField(bankTransfer, "bank_name", "bankName") ||
        pickField(d, "bank_name", "bankName") ||
        "Providus Bank",
    ).trim();

    // The payment card renders `qrCode` as an <img src>, so prefer the renderable
    // image URL, then the raw EMVCo string, then any generic code/url field.
    const qrCode =
      (pickField(
        qrChannel,
        "qr_image_url",
        "image_url",
        "imageUrl",
        "svg_url",
        "qr_string",
        "url",
        "code",
        "value",
      ) as string | null) || null;

    // `ussd` is consumed as Record<bankLabel, dialString> by the payment card, so
    // use the nested `bank_codes` map when present (else the channel object).
    const ussdRaw = (ussdChannel.bank_codes ?? ussdChannel) as Record<string, unknown>;
    const ussdEntries = Object.entries(
      ussdRaw && typeof ussdRaw === "object" ? ussdRaw : {},
    ).filter(([, v]) => typeof v === "string" && v.trim().length > 0);
    const ussd: Record<string, string> | null =
      ussdEntries.length > 0
        ? Object.fromEntries(ussdEntries.map(([k, v]) => [k, String(v)]))
        : null;

    return {
      success: true,
      raw: json,
      data: {
        accountNumber,
        accountName,
        bankName,
        qrCode,
        qrSvgUrl:
          (pickField(qrChannel, "qr_string", "svg_url", "svgUrl") as string | null) ||
          null,
        ussd,
        expiresAt:
          (pickField(d, "expires_at", "expiresAt", "expiry_date") as string | null) ??
          null,
        status:
          ((pickField(d, "status") as string | null) ?? "").trim().toLowerCase() ||
          null,
        gpayReference:
          (pickField(d, "reference", "gpay_reference", "transaction_ref") as string | null) ??
          null,
        merchantTransactionRef:
          (pickField(d, "merchant_transaction_ref") as string | null) ??
          params.merchantTransactionRef,
        raw: d,
      },
    };
  } catch (err: any) {
    console.error(
      "[gpay.service] createDynamicAccount error:",
      err?.message ?? err,
    );
    return {
      success: false,
      error: err?.message ?? "GPay dynamic account request failed",
    };
  }
}

export interface DynamicVerifyData {
  status: NormalizedStatus;
  rawStatus: string | null;
  isPaid: boolean;
  amount: string | null;
  currency: string | null;
  gpayReference: string | null;
  merchantTransactionRef: string | null;
  accountNumber: string | null;
  paidAtRaw: string | null;
  expiresAtRaw: string | null;
  raw: any;
}

/**
 * GET /transactions/verify?reference= — accepts gpay_reference,
 * merchant_transaction_ref, or account_number. Polls a dynamic VA payment
 * while the 15-minute countdown runs; the webhook is the primary signal,
 * this is the fallback the frontend polls.
 */
export async function verifyDynamicAccount(
  reference: string,
): Promise<GpayResult<DynamicVerifyData>> {
  try {
    const url = `${GPAY_BASE_URL}/transactions/verify?reference=${encodeURIComponent(
      reference,
    )}`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${GPAY_AUTH_SECRET}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(GPAY_TIMEOUT_MS),
    });

    const json = await safeJson(res);

    if (!res.ok || !isEnvelopeSuccess(json)) {
      return {
        success: false,
        error: envelopeError(json, "Failed to verify GPay transaction"),
        raw: json,
      };
    }

    const d = (json?.data ?? {}) as Record<string, unknown>;
    const rawStatus = (d.status as string | null) ?? null;
    const orderDetails = d.order_details as Record<string, unknown> | undefined;
    const mpgsResult =
      ((orderDetails?.result as string | undefined) ??
        (d.result as string | undefined) ??
        null) as string | null;

    return {
      success: true,
      raw: json,
      data: {
        status: normalizeGatewayStatus(rawStatus ?? mpgsResult),
        rawStatus,
        // Success is per-status ONLY here: unlike checkout, a dynamic VA has no
        // MPGS order block, so a "SUCCESS" leak from another field must not
        // promote a pending credit.
        isPaid: normalizeGatewayStatus(rawStatus) === "successful",
        amount:
          (d.amount as string | null) ?? (d.amount_settled as string | null) ?? null,
        currency: (d.currency as string | null) ?? null,
        gpayReference:
          ((d.gpay_reference as string | null) ??
            (d.reference as string | null) ??
            null) as string | null,
        merchantTransactionRef:
          (d.merchant_transaction_ref as string | null) ?? null,
        accountNumber: (d.account_number as string | null) ?? null,
        paidAtRaw: (d.paid_at as string | null) ?? null,
        expiresAtRaw: (d.expires_at as string | null) ?? null,
        raw: d,
      },
    };
  } catch (err: any) {
    console.error(
      "[gpay.service] verifyDynamicAccount error:",
      err?.message ?? err,
    );
    return {
      success: false,
      error: err?.message ?? "GPay verify request failed",
    };
  }
}




