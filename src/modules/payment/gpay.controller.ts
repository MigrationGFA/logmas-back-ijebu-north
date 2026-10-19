import { Request, Response, NextFunction } from "express";

import type { PaymentIntent } from "@prisma/client";
import { completeNewApplicationAfterPayment, confirmPayment } from "./payment.service";
import { prisma } from "../../utils/prisma";
import { sendError, sendSuccess } from "../../utils/response";
import { generateReference } from "../../utils/generators";
import {
  initiateCheckout,
  pickCheckoutUrl,
  sameAmount,
  verifyTransaction,
  verifyWebhookSignature,
  isWebhookPaymentEvent,
  isWebhookPaid,
  type GpayWebhookPayload,
  SERVICE_CODE_BY_SERVICE,
  findReservedAccount,
  isReservedVaWebhook,
  isDynamicVaWebhook,
  createDynamicAccount,
  verifyDynamicAccount,
  DYNAMIC_ACCOUNT_EXPIRY_MINUTES,
  normalizeGatewayStatus,
  parseLagosDateTime,
  serviceCodeForGpay,
  type GpayReservedVaWebhookData,
  type GpayDynamicVaWebhookData,
  type ReservedVirtualAccount,
} from "./gpay.service";
import { notify } from "../notification/notification.service";
import { LGA_CONFIG } from "../../config/lga.config";

// ─────────────────────────────────────────────────────────────
// GPay (Mastercard MPGS) controllers
//
// Two flows, mirroring the existing Paystack endpoints 1:1:
//   * initializeGpayInvoicePayment — an existing invoice paid by a logged-in user
//   * initializeGpayPublicPayment  — public "apply + pay first" flow
//
// Both create a PaymentIntent row BEFORE redirecting the payer, because GPay
// echoes no metadata back. verifyGpayPayment / gpayWebhook then read that row
// to know what the money was for.
// ─────────────────────────────────────────────────────────────

/** Placeholder used only when a user has no phone on file (User.phone is nullable). */
const PHONE_PLACEHOLDER = "08000000000";

function fullNameOf(user: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}): string {
  const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
  if (name) return name;
  return (user.email ?? "").split("@")[0] || `${LGA_CONFIG.name} LGA Taxpayer`;
}

function phoneOf(phone: string | null | undefined, context: string): string {
  const value = phone?.trim();
  if (value) return value;
  console.warn(
    `[gpay.controller] no phone on file for ${context} — sending placeholder to GPay.`,
  );
  return PHONE_PLACEHOLDER;
}

/** Persists the raw gateway envelope on the intent so outcomes stay auditable. */
async function recordLastResponse(intentId: string, raw: any, status?: string) {
  try {
    await prisma.paymentIntent.update({
      where: { id: intentId },
      data: {
        lastResponse: raw ?? undefined,
        ...(status ? { status: status as any } : {}),
      },
    });
  } catch (err) {
    console.error("[gpay.controller] failed to record gateway response:", err);
  }
}

// ── Invoice flow: POST /api/v1/payments/gpay/initialize/:invoiceNumber ──

export const initializeGpayInvoicePayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { invoiceNumber } = req.params;
    const userId = req.user!.id;
    const userEmail = req.user!.email;

    const invoice = await prisma.invoice.findUnique({
      where: { invoiceNumber: String(invoiceNumber) },
      include: { service: { select: { name: true } } },
    });

    if (!invoice) {
      return sendError(res, "Invoice not found", "NOT_FOUND", null, 404);
    }

    if (["paid", "cancelled"].includes(invoice.paymentStatus)) {
      return sendError(
        res,
        "Invoice is already paid or cancelled",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true, lastName: true, phone: true },
    });

    // GPay takes Naira decimals — NOT kobo. No *100 here.
    const amount = Number(invoice.amount);
    const reference = generateReference("PAY");
    const customerName = fullNameOf(user ?? { email: userEmail });
    const customerPhone = phoneOf(user?.phone, `user ${userId}`);

    const intent = await prisma.paymentIntent.create({
      data: {
        reference,
        provider: "gpay",
        flow: "invoice_online",
        amount,
        currency: "NGN",
        status: "pending",
        invoiceId: invoice.id,
        payload: {
          flow: "invoice_online",
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          userId,
          fullName: customerName,
          email: userEmail,
          phone: customerPhone,
        },
      },
    });

    const gatewayResult = await initiateCheckout({
      amount,
      currency: "NGN",
      merchantTransactionRef: reference,
      customerName,
      customerEmail: userEmail,
      customerPhone,
      description: `${invoice.service?.name ?? `${LGA_CONFIG.name} LGA Payment`} — ${invoice.invoiceNumber}`,
    });

    if (!gatewayResult.success || !gatewayResult.data) {
      await recordLastResponse(intent.id, gatewayResult.raw ?? null, "failed");

      return sendError(
        res,
        gatewayResult.error ?? "Failed to initialize payment",
        "PAYMENT_INITIALIZATION_FAILED",
        null,
        400,
      );
    }

    const data = gatewayResult.data;
    const checkoutUrl = pickCheckoutUrl(data);

    if (!checkoutUrl) {
      await recordLastResponse(intent.id, gatewayResult.raw ?? null, "failed");
      return sendError(
        res,
        "GPay did not return a checkout URL",
        "PAYMENT_INITIALIZATION_FAILED",
        null,
        502,
      );
    }

    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        gpayReference: data.transactionRef,
        mastercardSessionId: data.mastercardSessionId,
        checkoutUrl,
        initiateResponse: gatewayResult.raw ?? undefined,
      },
    });

    // Keep the same pending Payment row the Paystack flow created, so confirmPayment
    // can find this attempt by reference when the webhook/verify lands.
    await prisma.payment.create({
      data: {
        invoice: { connect: { id: invoice.id } },
        amount,
        method: "online_gateway",
        status: "pending",
        reference,
        paidBy: { connect: { id: userId } },
      },
    });

    return sendSuccess(res, {
      paymentUrl: checkoutUrl,
      reference,
      amount,
      invoiceNumber: invoice.invoiceNumber,
      gateway: "gpay",
      message: "Redirect user to paymentUrl to complete payment",
    });
  } catch (err) {
    next(err);
  }
};

// ── Public flow: POST /api/v1/payments/gpay/public/initialize ──

interface GpayPublicPaymentBody {
  serviceId: string;
  fullName: string;
  email: string;
  phone: string;
}

export const initializeGpayPublicPayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { serviceId, fullName, email, phone } =
      req.body as GpayPublicPaymentBody;

    if (!serviceId || !fullName || !email || !phone) {
      return sendError(
        res,
        "Service ID, full name, email and phone number are required",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanName = fullName.trim();
    const cleanPhone = phone.trim();

    // 1. Service + current fee
    const service = await prisma.service.findUnique({
      where: { id: serviceId },
      include: { feeConfig: true },
    });

    if (!service) {
      return sendError(res, "Service not found", "NOT_FOUND", null, 404);
    }

    if (!service.isActive) {
      return sendError(
        res,
        "Service is not active",
        "SERVICE_INACTIVE",
        null,
        400,
      );
    }

    if (!service.feeConfig || service.feeConfig.status !== "ACTIVE") {
      return sendError(
        res,
        "Service fee is not configured",
        "SERVICE_FEE_NOT_CONFIGURED",
        null,
        400,
      );
    }

    // GPay takes Naira decimals — NOT kobo.
    const amount = Number(service.feeConfig.amount);
    const reference = generateReference("PAY");

    // If this person already has an account we remember it, but nothing is
    // created here — the user/application/invoice are only created once the
    // payment is confirmed (same behaviour as the Paystack flow).
    const existingUser = await prisma.user.findUnique({
      where: { email: cleanEmail },
      select: { id: true },
    });

    // Everything needed to finish the application later. GPay echoes no
    // metadata, so this is the only copy of the context.
    const payload = {
      flow: "new_application",
      serviceId: service.id,
      serviceCode: service.code,
      serviceName: service.name,
      fullName: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
      userId: existingUser?.id ?? null,
    };

    const intent = await prisma.paymentIntent.create({
      data: {
        reference,
        provider: "gpay",
        flow: "new_application",
        amount,
        currency: "NGN",
        status: "pending",
        payload,
      },
    });

    const gatewayResult = await initiateCheckout({
      amount,
      currency: "NGN",
      merchantTransactionRef: reference,
      customerName: cleanName,
      customerEmail: cleanEmail,
      customerPhone: cleanPhone,
      description: `${service.name} — ${LGA_CONFIG.name} LGA`,
    });

    if (!gatewayResult.success || !gatewayResult.data) {
      await recordLastResponse(intent.id, gatewayResult.raw ?? null, "failed");

      return sendError(
        res,
        gatewayResult.error ?? "Failed to initialize payment",
        "PAYMENT_INITIALIZATION_FAILED",
        null,
        400,
      );
    }

    const data = gatewayResult.data;
    const checkoutUrl = pickCheckoutUrl(data);

    if (!checkoutUrl) {
      await recordLastResponse(intent.id, gatewayResult.raw ?? null, "failed");
      return sendError(
        res,
        "GPay did not return a checkout URL",
        "PAYMENT_INITIALIZATION_FAILED",
        null,
        502,
      );
    }

    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        gpayReference: data.transactionRef,
        mastercardSessionId: data.mastercardSessionId,
        checkoutUrl,
        initiateResponse: gatewayResult.raw ?? undefined,
      },
    });

    return sendSuccess(res, {
      paymentUrl: checkoutUrl,
      reference,
      amount,
      serviceId: service.id,
      flow: "new_application",
      gateway: "gpay",
    });
  } catch (err) {
    next(err);
  }
};

// ── Dynamic virtual account: POST /dynamic-account/* ──
//
// A one-shot Providus account minted for exactly this amount, expiring after
// DYNAMIC_ACCOUNT_EXPIRY_MINUTES (15). Same PaymentIntent-first discipline as
// the checkout flows — GPay echoes no metadata, so the intent row is created
// BEFORE the gateway call and carries everything settlement needs.

/**
 * GPay expiry timestamps carry no zone ("2026-09-25 15:18:20" = Lagos) unless
 * the string says otherwise. Parse accordingly; null when unparseable.
 */
function parseGatewayExpiry(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return parseLagosDateTime(trimmed);
}

/** Everything the payment page needs to render the transfer card. */
function dynamicAccountResponse(
  data: {
    accountNumber: string;
    accountName: string;
    bankName: string;
    qrCode: string | null;
    ussd: Record<string, string> | null;
    expiresAt: string | null;
  },
  expiresAt: Date,
  base: Record<string, unknown>,
) {
  return {
    ...base,
    gateway: "gpay",
    channel: "dynamic_va",
    accountNumber: data.accountNumber,
    accountName: data.accountName,
    bankName: data.bankName,
    qrCode: data.qrCode,
    ussd: data.ussd,
    expiresAt: expiresAt.toISOString(),
    expiresInSeconds: Math.max(
      0,
      Math.round((expiresAt.getTime() - Date.now()) / 1000),
    ),
  };
}

// ── Dynamic VA, invoice flow: POST /api/v1/payments/gpay/dynamic-account/invoices/:invoiceNumber ──

export const createDynamicAccountForInvoice = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { invoiceNumber } = req.params;
    const userId = req.user!.id;
    const userEmail = req.user!.email;

    const invoice = await prisma.invoice.findUnique({
      where: { invoiceNumber: String(invoiceNumber) },
      include: { service: { select: { name: true } } },
    });

    if (!invoice) {
      return sendError(res, "Invoice not found", "NOT_FOUND", null, 404);
    }

    if (invoice.paymentStatus !== "pending") {
      return sendError(
        res,
        `Invoice is already ${invoice.paymentStatus}`,
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true, lastName: true, phone: true },
    });

    // GPay takes Naira decimals — NOT kobo. No *100 here.
    const amount = Number(invoice.amount);
    const reference = generateReference("PAY");
    const customerName = fullNameOf(user ?? { email: userEmail });
    const customerPhone = phoneOf(user?.phone, `user ${userId}`);

    const intent = await prisma.paymentIntent.create({
      data: {
        reference,
        provider: "gpay",
        flow: "invoice_online",
        amount,
        currency: "NGN",
        status: "pending",
        invoiceId: invoice.id,
        payload: {
          flow: "invoice_online",
          channel: "dynamic_va",
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          userId,
          fullName: customerName,
          email: userEmail,
          phone: customerPhone,
        },
      },
    });

    const gatewayResult = await createDynamicAccount({
      accountName: `${LGA_CONFIG.accountPrefix}/${invoice.invoiceNumber}`,
      amount,
      customerName,
      customerEmail: userEmail,
      customerPhone,
      merchantTransactionRef: reference,
    });

    if (!gatewayResult.success || !gatewayResult.data) {
      await recordLastResponse(intent.id, gatewayResult.raw ?? null, "failed");

      return sendError(
        res,
        gatewayResult.error ?? "Failed to create transfer account",
        "PAYMENT_INITIALIZATION_FAILED",
        null,
        400,
      );
    }

    const data = gatewayResult.data;

    if (!data.accountNumber) {
      await recordLastResponse(intent.id, gatewayResult.raw ?? null, "failed");
      return sendError(
        res,
        "GPay did not return an account number",
        "PAYMENT_INITIALIZATION_FAILED",
        null,
        502,
      );
    }

    const expiresAt =
      parseGatewayExpiry(data.expiresAt) ??
      new Date(Date.now() + DYNAMIC_ACCOUNT_EXPIRY_MINUTES * 60_000);

    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        gpayReference: data.gpayReference,
        initiateResponse: gatewayResult.raw ?? undefined,
        expiresAt,
      },
    });

    // Keep the same pending Payment row the checkout flow creates, so
    // confirmPayment can find this attempt by reference when the webhook/verify
    // lands.
    await prisma.payment.create({
      data: {
        invoice: { connect: { id: invoice.id } },
        amount,
        method: "online_gateway",
        status: "pending",
        reference,
        paidBy: { connect: { id: userId } },
      },
    });

    return sendSuccess(
      res,
      dynamicAccountResponse(data, expiresAt, {
        reference,
        amount,
        invoiceNumber: invoice.invoiceNumber,
        message:
          "Transfer the exact amount to this account before it expires. Payment confirms automatically.",
      }),
    );
  } catch (err) {
    next(err);
  }
};

// ── Dynamic VA, public flow: POST /api/v1/payments/gpay/dynamic-account/public ──

export const createDynamicAccountPublicPayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { serviceId, fullName, email, phone } =
      req.body as GpayPublicPaymentBody;

    if (!serviceId || !fullName || !email || !phone) {
      return sendError(
        res,
        "Service ID, full name, email and phone number are required",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanName = fullName.trim();
    const cleanPhone = phone.trim();

    // 1. Service + current fee
    const service = await prisma.service.findUnique({
      where: { id: serviceId },
      include: { feeConfig: true },
    });

    if (!service) {
      return sendError(res, "Service not found", "NOT_FOUND", null, 404);
    }

    if (!service.isActive) {
      return sendError(
        res,
        "Service is not active",
        "SERVICE_INACTIVE",
        null,
        400,
      );
    }

    if (!service.feeConfig || service.feeConfig.status !== "ACTIVE") {
      return sendError(
        res,
        "Service fee is not configured",
        "SERVICE_FEE_NOT_CONFIGURED",
        null,
        400,
      );
    }

    // GPay takes Naira decimals — NOT kobo.
    const amount = Number(service.feeConfig.amount);
    const reference = generateReference("PAY");

    // If this person already has an account we remember it, but nothing is
    // created here — the user/application/invoice are only created once the
    // payment is confirmed (same behaviour as the checkout flow).
    const existingUser = await prisma.user.findUnique({
      where: { email: cleanEmail },
      select: { id: true },
    });

    // Everything needed to finish the application later. GPay echoes no
    // metadata, so this is the only copy of the context.
    const payload = {
      flow: "new_application",
      channel: "dynamic_va",
      serviceId: service.id,
      serviceCode: service.code,
      serviceName: service.name,
      fullName: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
      userId: existingUser?.id ?? null,
    };

    const intent = await prisma.paymentIntent.create({
      data: {
        reference,
        provider: "gpay",
        flow: "new_application",
        amount,
        currency: "NGN",
        status: "pending",
        payload,
      },
    });

    const gatewayResult = await createDynamicAccount({
      accountName: `${LGA_CONFIG.accountPrefix}/${service.code}`,
      amount,
      customerName: cleanName,
      customerEmail: cleanEmail,
      customerPhone: cleanPhone,
      merchantTransactionRef: reference,
    });

    if (!gatewayResult.success || !gatewayResult.data) {
      await recordLastResponse(intent.id, gatewayResult.raw ?? null, "failed");

      return sendError(
        res,
        gatewayResult.error ?? "Failed to create transfer account",
        "PAYMENT_INITIALIZATION_FAILED",
        null,
        400,
      );
    }

    const data = gatewayResult.data;

    if (!data.accountNumber) {
      await recordLastResponse(intent.id, gatewayResult.raw ?? null, "failed");
      return sendError(
        res,
        "GPay did not return an account number",
        "PAYMENT_INITIALIZATION_FAILED",
        null,
        502,
      );
    }

    const expiresAt =
      parseGatewayExpiry(data.expiresAt) ??
      new Date(Date.now() + DYNAMIC_ACCOUNT_EXPIRY_MINUTES * 60_000);

    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: {
        gpayReference: data.gpayReference,
        initiateResponse: gatewayResult.raw ?? undefined,
        expiresAt,
      },
    });

    return sendSuccess(
      res,
      dynamicAccountResponse(data, expiresAt, {
        reference,
        amount,
        serviceId: service.id,
        flow: "new_application",
        message:
          "Transfer the exact amount to this account before it expires. Payment confirms automatically.",
      }),
    );
  } catch (err) {
    next(err);
  }
};

// ── Shared: turn a paid gateway response into a confirmed payment ──

interface SettleParams {
  reference: string;
  amount: number;
  gpayReference: string | null;
  gatewayReference: string | null;
  mastercardSessionId: string | null;
  raw: any;
  source: "verify" | "webhook";
}

type SettleOutcome =
  | { status: "confirmed"; result: any }
  | { status: "already_confirmed" }
  | { status: "amount_mismatch" }
  | { status: "error"; error: string };

async function settleIntent(
  intent: PaymentIntent,
  params: SettleParams,
): Promise<SettleOutcome> {
  if (intent.status === "confirmed") {
    return { status: "already_confirmed" };
  }

  // Never confirm an amount that doesn't match what we asked for. This is the
  // guard the old Paystack flow was missing.
  if (!sameAmount(params.amount, intent.amount)) {
    console.error(
      `[gpay.${params.source}] amount mismatch for ${intent.reference}: ` +
        `gateway=${params.amount} expected=${intent.amount} — refusing to confirm`,
    );
    await recordLastResponse(intent.id, params.raw);
    return { status: "amount_mismatch" };
  }

  const payload = (intent.payload ?? {}) as any;
  const gatewayRef = params.gpayReference ?? intent.gpayReference ?? undefined;

  let result: any;

  if (intent.flow === "new_application") {
    // Rebuild the metadata object the completion service expects. GPay gives us
    // nothing back, so this comes entirely from the stored intent payload.
    result = await completeNewApplicationAfterPayment({
      paymentReference: intent.reference,
      amount: params.amount,
      gatewayRef,
      metadata: {
        flow: "new_application",
        serviceId: payload.serviceId,
        fullName: payload.fullName,
        email: payload.email,
        phone: payload.phone,
        userId: payload.userId ?? null,
      },
    });
  } else {
    if (!intent.invoiceId) {
      console.error(
        `[gpay.${params.source}] intent ${intent.reference} has no linked invoice`,
      );
      return { status: "error", error: "Payment intent has no linked invoice" };
    }

    result = await confirmPayment({
      invoiceId: intent.invoiceId,
      amount: params.amount,
      method: "online_gateway",
      reference: intent.reference,
      gatewayRef,
      paidById: payload.userId ?? null,
      confirmedById: null,
    });
  }

  const now = new Date();

  await prisma.paymentIntent.update({
    where: { id: intent.id },
    data: {
      status: "confirmed",
      // We stamp confirmation time ourselves: GPay's timestamps ("2026-09-25
      // 15:18:20") carry no timezone, so the raw value stays in lastResponse
      // and is never used to date a receipt.
      paidAt: now,
      completedAt: now,
      gatewayReference: params.gatewayReference ?? intent.gatewayReference,
      mastercardSessionId:
        params.mastercardSessionId ?? intent.mastercardSessionId,
      gpayReference: gatewayRef,
      lastResponse: params.raw ?? undefined,
    },
  });

  return { status: "confirmed", result };
}

// ── Verify: GET /api/v1/payments/gpay/verify/:reference ──

export const verifyGpayPayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const reference = req.params.reference as string;

    const intent = await prisma.paymentIntent.findUnique({
      where: { reference },
    });

    if (!intent) {
      return sendError(
        res,
        "Payment reference not found",
        "NOT_FOUND",
        null,
        404,
      );
    }

    if (intent.status === "confirmed") {
      return sendSuccess(res, {
        status: "confirmed",
        flow: intent.flow,
        reference,
        alreadyConfirmed: true,
      });
    }

    const verifyResult = await verifyTransaction(reference);

    if (!verifyResult.success || !verifyResult.data) {
      return sendError(
        res,
        verifyResult.error ?? "Failed to verify with GPay",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const data = verifyResult.data;
    await recordLastResponse(intent.id, verifyResult.raw ?? null);

    if (!data.isPaid) {
      if (data.status === "failed") {
        await prisma.paymentIntent.update({
          where: { id: intent.id },
          data: { status: "failed" },
        });
      }

      return sendSuccess(res, {
        status: data.status,
        reference,
        rawStatus: data.rawStatus,
        mpgsResult: data.mpgsResult,
      });
    }

    const outcome = await settleIntent(intent, {
      reference,
      amount: Number(data.amount),
      gpayReference: data.gpayReference,
      gatewayReference: data.gatewayReference,
      mastercardSessionId: data.mastercardSessionId,
      raw: verifyResult.raw ?? null,
      source: "verify",
    });

    if (outcome.status === "amount_mismatch") {
      return sendError(
        res,
        "Paid amount does not match the expected amount",
        "AMOUNT_MISMATCH",
        null,
        409,
      );
    }

    if (outcome.status === "error") {
      return sendError(
        res,
        outcome.error,
        "PAYMENT_CONFIRMATION_FAILED",
        null,
        500,
      );
    }

    const confirmedPayload: any = {
      status: "confirmed",
      flow: intent.flow,
      ...(outcome.status === "confirmed" ? outcome.result : {}),
    };

    // The payment IS settled, but the confirmation/credentials email didn't go
    // out. Surface it as an error (EMAIL_SEND_FAILED): the result page reads
    // backendDetails to show "paid, but the email failed" instead of a silent
    // success the citizen would never notice.
    if (confirmedPayload.emailSent === false) {
      return sendError(
        res,
        `Payment confirmed for ${reference}, but the confirmation email could not be sent. Contact the LGA with this reference.`,
        "EMAIL_SEND_FAILED",
        confirmedPayload,
        502,
      );
    }

    return sendSuccess(res, confirmedPayload);
  } catch (err) {
    next(err);
  }
};

// ── Verify a dynamic VA payment: GET /api/v1/payments/gpay/dynamic-account/verify/:reference ──
//
// Frontend polls this while the 15-minute countdown runs. The webhook is the
// primary settlement signal; this is the fallback for when tunnels/delivery
// fail. Unlike verifyGpayPayment it must NOT fall back to an MPGS order block —
// a dynamic VA has none, and a stray "SUCCESS" elsewhere must not promote a
// pending credit.

export const verifyDynamicAccountPayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const reference = req.params.reference as string;

    const intent = await prisma.paymentIntent.findUnique({
      where: { reference },
    });

    if (!intent) {
      return sendError(
        res,
        "Payment reference not found",
        "NOT_FOUND",
        null,
        404,
      );
    }

    if (intent.status === "confirmed") {
      return sendSuccess(res, {
        status: "confirmed",
        flow: intent.flow,
        reference,
        alreadyConfirmed: true,
      });
    }

    // Past expiry with no settlement? Let the caller show "expired" — but only
    // the gateway's own verdict can flip the row to failed, never the clock.
    const expired = intent.expiresAt
      ? intent.expiresAt.getTime() < Date.now()
      : false;

    const verifyResult = await verifyDynamicAccount(reference);

    if (!verifyResult.success || !verifyResult.data) {
      return sendError(
        res,
        verifyResult.error ?? "Failed to verify with GPay",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const data = verifyResult.data;
    await recordLastResponse(intent.id, verifyResult.raw ?? null);

    if (!data.isPaid) {
      if (data.status === "failed") {
        await prisma.paymentIntent.update({
          where: { id: intent.id },
          data: { status: "failed" },
        });
      }

      return sendSuccess(res, {
        status: expired ? "expired" : data.status,
        reference,
        rawStatus: data.rawStatus,
        expiresAt: intent.expiresAt?.toISOString() ?? null,
      });
    }

    const outcome = await settleIntent(intent, {
      reference,
      amount: Number(data.amount),
      gpayReference: data.gpayReference,
      gatewayReference: null,
      mastercardSessionId: null,
      raw: verifyResult.raw ?? null,
      source: "verify",
    });

    if (outcome.status === "amount_mismatch") {
      return sendError(
        res,
        "Paid amount does not match the expected amount",
        "AMOUNT_MISMATCH",
        null,
        409,
      );
    }

    if (outcome.status === "error") {
      return sendError(
        res,
        outcome.error,
        "PAYMENT_CONFIRMATION_FAILED",
        null,
        500,
      );
    }

    return sendSuccess(res, {
      status: "confirmed",
      flow: intent.flow,
      ...(outcome.status === "confirmed" ? outcome.result : {}),
    });
  } catch (err) {
    next(err);
  }
};

// ── Reserved virtual account details ──────────────────────────────────────
// Two entry points share one resolver:
//   * getVirtualAccountForService — PUBLIC, keyed by serviceId (no invoice yet)
//   * getInvoiceVirtualAccount    — AUTHED,  keyed by invoiceNumber
//
// The client only ever passes an IDENTITY. The account itself is resolved
// server side (service → map → GPay service_code → one active account) so a
// browser can never be handed the wrong service's account, and the reserved
// pool is never serialized to a client.

/**
 * Reuse window for the pending reference. Re-reading the page re-quotes the
 * SAME reference instead of minting another candidate — two candidates would be
 * flagged `ambiguous` by the webhook and never auto-attach.
 */
const VA_REUSE_WINDOW_MS = 60 * 60 * 1000;

interface VaFailure {
  code: string;
  message: string;
  status: number;
}

const vaUnavailable = (message: string): VaFailure => ({
  code: "VIRTUAL_ACCOUNT_UNAVAILABLE",
  message,
  status: 404,
});

/** Our one active reserved account for a service, or the reason we can't give one. */
async function resolveReservedAccount(
  serviceCode: string,
): Promise<{ account: ReservedVirtualAccount } | { failure: VaFailure }> {
  const gpayServiceCode = SERVICE_CODE_BY_SERVICE[serviceCode];

  if (!gpayServiceCode) {
    console.warn(
      `[gpay.va] no reserved-account mapping for service "${serviceCode}"`,
    );
    return {
      failure: vaUnavailable("Bank transfer is not available for this service"),
    };
  }

  try {
    const account = await findReservedAccount(gpayServiceCode);
    if (!account) {
      return {
        failure: vaUnavailable(
          "No active transfer account is available for this service",
        ),
      };
    }
    return { account };
  } catch (err: any) {
    console.error(
      "[gpay.va] reserved account lookup failed:",
      err?.message ?? err,
    );
    return { failure: vaUnavailable("Transfer account lookup failed") };
  }
}

/** The pending Payment whose `reference` the citizen quotes in their narration. */
async function pendingTransferReference(opts: {
  serviceCode: string;
  amount: number;
  invoiceId?: string | null;
}): Promise<string> {
  const existing = await prisma.payment.findFirst({
    where: {
      status: "pending",
      method: "bank_transfer",
      serviceCode: opts.serviceCode,
      invoiceId: opts.invoiceId ?? null,
      createdAt: { gte: new Date(Date.now() - VA_REUSE_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: { reference: true },
  });
  if (existing) return existing.reference;

  const reference = generateReference();
  await prisma.payment.create({
    data: {
      reference,
      amount: opts.amount,
      method: "bank_transfer",
      status: "pending",
      serviceCode: opts.serviceCode,
      ...(opts.invoiceId ? { invoice: { connect: { id: opts.invoiceId } } } : {}),
    },
  });
  return reference;
}

/**
 * GET /api/v1/payments/gpay/virtual-account?serviceId=
 * PUBLIC. Asks for nothing but the service identity — never an account number.
 */
export const getVirtualAccountForService = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const serviceId = String(req.query.serviceId ?? "").trim();
    if (!serviceId) {
      return sendError(res, "serviceId is required", "VALIDATION_ERROR", null, 400);
    }

    const service = await prisma.service.findUnique({
      where: { id: serviceId },
      include: { feeConfig: true },
    });

    if (!service) {
      return sendError(res, "Service not found", "NOT_FOUND", null, 404);
    }
    if (!service.isActive) {
      return sendError(res, "Service is not active", "SERVICE_INACTIVE", null, 400);
    }
    if (!service.feeConfig || service.feeConfig.status !== "ACTIVE") {
      return sendError(
        res,
        "Service fee is not configured",
        "SERVICE_FEE_NOT_CONFIGURED",
        null,
        400,
      );
    }

    const resolved = await resolveReservedAccount(service.code);
    if ("failure" in resolved) {
      return sendError(
        res,
        resolved.failure.message,
        resolved.failure.code,
        null,
        resolved.failure.status,
      );
    }

    const expectedAmount = Number(service.feeConfig.amount);
    const reference = await pendingTransferReference({
      serviceCode: service.code,
      amount: expectedAmount,
    });

    // Allow-list only: total_settled / bank_code / created_at / service_name
    // and the rest of the reserved-account payload never leave the server.
    return sendSuccess(res, {
      bankName: resolved.account.bankName,
      accountNumber: resolved.account.accountNumber,
      accountName: resolved.account.accountName,
      reference,
      expectedAmount,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/invoices/:invoiceNumber/virtual-account
 * Also mounted as /api/v1/payments/gpay/invoices/:invoiceNumber/virtual-account
 * (the handler is shared; both URLs work during rollout).
 * Same guards as initializeGpayInvoicePayment.
 */
export const getInvoiceVirtualAccount = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { invoiceNumber } = req.params;

    const invoice = await prisma.invoice.findUnique({
      where: { invoiceNumber: String(invoiceNumber) },
      include: { service: { select: { id: true, code: true, name: true } } },
    });

    if (!invoice) {
      return sendError(res, "Invoice not found", "NOT_FOUND", null, 404);
    }
    // PaymentStatus is pending|confirmed|failed|reversed — it has no "paid" or
    // "cancelled" member, so the old ["paid","cancelled"] guard could never
    // fire and a settled invoice was still handed transfer instructions.
    if (invoice.paymentStatus !== "pending") {
      return sendError(
        res,
        `Invoice is already ${invoice.paymentStatus}`,
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const resolved = await resolveReservedAccount(invoice.service.code);
    if ("failure" in resolved) {
      return sendError(
        res,
        resolved.failure.message,
        resolved.failure.code,
        null,
        resolved.failure.status,
      );
    }

    const amount = Number(invoice.amount);
    const reference = await pendingTransferReference({
      serviceCode: invoice.service.code,
      amount,
      invoiceId: invoice.id,
    });

    // First read only. Gated on virtualAccountNumber because virtualBankName
    // already carries a stale column default on EVERY existing row, so gating
    // on it would never fire — and would leave "Zenith Bank" on screen.
    if (!invoice.virtualAccountNumber) {
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          virtualAccountNumber: resolved.account.accountNumber,
          virtualBankName: resolved.account.bankName,
        },
      });
    }

    return sendSuccess(res, {
      bankName: resolved.account.bankName,
      accountNumber: resolved.account.accountNumber,
      accountName: resolved.account.accountName,
      reference,
      expectedAmount: amount,
      amount,
      invoiceNumber: invoice.invoiceNumber,
    });
  } catch (err) {
    next(err);
  }
};

// ── Dynamic virtual account settlement ─────────────────────────────────────
//
// Runs ONLY for the dynamic dialect (isDynamicVaWebhook) and always AFTER the
// 200-ack. The `merchant_transaction_ref` here is the reference WE minted, so
// unlike the reserved pool an exact PaymentIntent lookup is safe. Status is
// checked per-status only — no MPGS order block exists to fall back on.

async function handleDynamicVaSettlement(payload: unknown) {
  const data = ((payload as { data?: unknown })?.data ??
    {}) as GpayDynamicVaWebhookData;

  const reference = str(data.merchant_transaction_ref);
  if (!reference) {
    console.error(
      "[gpay.webhook] dynamic VA settlement has no merchant_transaction_ref",
    );
    return;
  }

  const intent = await prisma.paymentIntent.findUnique({
    where: { reference },
  });

  if (!intent) {
    // A late or replayed delivery for an intent we no longer have. Log it —
    // never route this to the reserved-VA matcher, whose `account_number`
    // candidates must not pick up a minted-account credit.
    console.error(
      `[gpay.webhook] no PaymentIntent found for dynamic VA reference ${reference}`,
    );
    return;
  }

  if (intent.status === "confirmed") {
    console.log(
      `[gpay.webhook] ${reference} already confirmed — ignoring duplicate delivery`,
    );
    return;
  }

  const status = normalizeGatewayStatus(data.status);

  if (status === "failed") {
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: "failed", lastResponse: payload as any },
    });
    console.warn(
      `[gpay.webhook] dynamic VA ${reference} reported failed — marking intent failed`,
    );
    return;
  }

  if (status !== "successful") {
    // Pending / unknown — leave it pending; the poll endpoint or a later
    // delivery promotes it. An unrecognised string is never a paid payment.
    await recordLastResponse(intent.id, payload);
    console.warn(
      `[gpay.webhook] dynamic VA ${reference} reported status "${data.status}" — leaving pending`,
    );
    return;
  }

  const amount = Number(data.amount_settled ?? data.amount);
  if (!Number.isFinite(amount)) {
    console.error(
      `[gpay.webhook] dynamic VA ${reference} settlement has no usable amount`,
    );
    await recordLastResponse(intent.id, payload);
    return;
  }

  const outcome = await settleIntent(intent, {
    reference,
    amount,
    gpayReference: str(data.gpay_reference) || intent.gpayReference,
    gatewayReference: null,
    mastercardSessionId: null,
    raw: payload,
    source: "webhook",
  });

  console.log(`[gpay.webhook] dynamic VA ${reference} → ${outcome.status}`);
}

// ── Webhook: POST /api/v1/payments/gpay/webhook ──

export const gpayWebhook = async (req: Request, res: Response) => {
  const signature = req.headers["x-gpay-signature"] as string | undefined;
  const rawBody = req.body as Buffer;

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn("[gpay.webhook] rejected — invalid signature");
    return res.status(401).json({
      success: false,
      message: "Invalid webhook signature",
    });
  }

  // Acknowledge GPay immediately; processing continues after the response.
  // Signature verification is what proves the call really came from GPay.
  res.status(200).json({ received: true });

  try {
    const payload = JSON.parse(rawBody.toString("utf8")) as GpayWebhookPayload;

    // Reserved virtual-account credits share `event: "charge.success"` with
    // checkout charges but carry a different shape. Branch on the DATA before
    // anything can look up a PaymentIntent: a VA `merchant_transaction_ref` is
    // Providus's settlement id, never ours, and must never touch that table.
    if (isReservedVaWebhook(payload)) {
      await handleReservedVaSettlement(payload);
      return;
    }

    // Dynamic VA settlements are a third dialect. Unlike the reserved pool the
    // `merchant_transaction_ref` IS ours (we minted the account with it), so
    // this branch may look up a PaymentIntent — but only after the reserved
    // check above, and only via our own unique reference.
    if (isDynamicVaWebhook(payload)) {
      await handleDynamicVaSettlement(payload);
      return;
    }

    if (!isWebhookPaymentEvent(payload)) {
      console.log(`[gpay.webhook] ignoring event: ${payload?.event}`);
      return;
    }

    const reference = payload.data?.merchant_transaction_ref;

    if (!reference) {
      console.error("[gpay.webhook] payload has no merchant_transaction_ref");
      return;
    }

    const intent = await prisma.paymentIntent.findUnique({
      where: { reference },
    });

    if (!intent) {
      console.error(
        `[gpay.webhook] no PaymentIntent found for reference ${reference}`,
      );
      return;
    }

    if (intent.status === "confirmed") {
      console.log(
        `[gpay.webhook] ${reference} already confirmed — ignoring duplicate delivery`,
      );
      return;
    }

    if (!isWebhookPaid(payload)) {
      console.warn(
        `[gpay.webhook] ${reference} reported status "${payload.data?.status}" — leaving pending`,
      );
      await recordLastResponse(intent.id, payload);
      return;
    }

    const outcome = await settleIntent(intent, {
      reference,
      amount: Number(payload.data?.amount),
      gpayReference: payload.data?.gpay_reference ?? null,
      gatewayReference: payload.data?.gateway_reference ?? null,
      mastercardSessionId: payload.data?.mastercard_session_id ?? null,
      raw: payload,
      source: "webhook",
    });

    console.log(`[gpay.webhook] ${reference} → ${outcome.status}`);
  } catch (err) {
    console.error("[gpay.webhook] processing error:", err);
  }
};

// ── Reserved virtual account settlement ───────────────────────────────────
//
// Runs ONLY for the VA dialect (isReservedVaWebhook) and always AFTER the
// 200-ack, BEFORE any PaymentIntent lookup — a VA `merchant_transaction_ref`
// is Providus's settlement id, never ours, and must not touch that table.
//
// It may attach a match or write a stub. It never flips Payment/Invoice
// status and never stamps confirmedAt/confirmedById: confirmation stays on
// the treasurer path.

/** Candidate lookback — credits older than this are never auto-attached. */
const VA_LOOKBACK_MS = 72 * 60 * 60 * 1000;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Tell whoever can reconcile it. Wrapped so a notification failure can never
 * fail webhook handling — the settlement itself is already persisted by then.
 */
async function notifyTreasuryReconciliation(vars: Record<string, string>) {
  try {
    const recipients = await prisma.user.findMany({
      where: { role: { in: ["treasurer"] } },
      select: { id: true, email: true, phone: true },
    });

    // NOTIFICATION_TEST_MODE routes the SMS/email to the configured test
    // recipient so integration runs never text a real colleague. The in-app
    // notification row still lands on the treasurer.
    const testMode = process.env.NOTIFICATION_TEST_MODE !== "false";
    const routedTo = {
      email: testMode
        ? process.env.TEST_RECIPIENT_EMAIL || undefined
        : undefined,
      phone: testMode
        ? process.env.TEST_RECIPIENT_PHONE || undefined
        : undefined,
    };

    for (const recipient of recipients) {
      await notify({
        userId: recipient.id,
        to: testMode
          ? routedTo
          : {
              email: recipient.email ?? undefined,
              phone: recipient.phone ?? undefined,
            },
        templateKey: "payment.unmatchedBankTransfer",
        vars,
        channels: ["email"],
      });
    }
  } catch (err) {
    console.error("[gpay.va] reconciliation notification failed:", err);
  }
}

/**
 * Records a credit we could not (or did not) attach to a pending Payment.
 * `serviceCode` holds OUR code when known; an unmapped credit leaves it null
 * and keeps GPay's code inside rawPayload rather than polluting the column.
 */
async function persistVaSettlementStub(opts: {
  payload: unknown;
  matchStatus: "unmatched" | "ambiguous";
  amount: number;
  ours: string | null;
  gatewayRef: string;
  settledAt: Date | null;
  payerName: string;
  payerAccount: string;
  payerBank: string;
}): Promise<string> {
  const reference = generateReference();

  await prisma.payment.create({
    data: {
      reference,
      amount: opts.amount,
      method: "virtual_account",
      status: "pending",
      serviceCode: opts.ours,
      gatewayRef: opts.gatewayRef || null,
      payerName: opts.payerName || null,
      payerAccount: opts.payerAccount || null,
      payerBank: opts.payerBank || null,
      settledAt: opts.settledAt,
      matchStatus: opts.matchStatus,
      rawPayload: (opts.payload ?? null) as any,
    },
  });

  return reference;
}

async function handleReservedVaSettlement(payload: unknown) {
  const data = ((payload as { data?: unknown })?.data ??
    {}) as GpayReservedVaWebhookData;

  const gpayRef = str(data.gpay_reference);
  const settleRef = str(data.providus_settlement_id);
  const sessionRef = str(data.providus_session_id);
  const status = str(data.status).toLowerCase();
  const rawAmount = str(data.amount_settled);
  const amount = Number(rawAmount);
  const paidAt = parseLagosDateTime(data.paid_at);
  const gpayServiceCode = str(data.service?.service_code);
  const ours = serviceCodeForGpay(gpayServiceCode);
  const gatewayRef = gpayRef || settleRef || sessionRef;

  const payer = data.payer_details ?? {};
  const payerName = str(payer.source_account_name);
  const payerAccount = str(payer.source_account_number);
  const payerBank = str(payer.source_bank_name);

  const ids = [gpayRef, settleRef, sessionRef].filter(Boolean);
  const logTag = gatewayRef || "unknown-settlement";
  const serviceLabel = ours ?? gpayServiceCode ?? "unknown service";

  const notifyVars = (
    matchStatus: string,
    reference: string,
  ): Record<string, string> => ({
    amount: `NGN ${amount.toFixed(2)}`,
    reference,
    match_status: matchStatus,
    service_name: serviceLabel,
    payer_name: payerName || "Unknown payer",
    payer_bank: payerBank || "Unknown bank",
    payer_account: payerAccount || "Unknown account",
    paid_at: paidAt ? paidAt.toISOString() : str(data.paid_at) || "Unknown",
    gateway_ref: gatewayRef || "n/a",
  });

  // A Payment row needs a real amount; with nothing usable there is no row to
  // write and nothing to match against. Log and hold.
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error(
      `[gpay.va] ${logTag} — amount_settled "${rawAmount}" is not a usable amount; holding without persisting`,
    );
    return;
  }

  // 1. DEDUPE FIRST — same settlement re-delivered. Already acked; stop here so
  //    a retry can never create a second row.
  if (ids.length) {
    const seen = await prisma.payment.findFirst({
      where: { gatewayRef: { in: ids } },
      select: { id: true, reference: true },
    });
    if (seen) {
      console.log(
        `[gpay.va] ${logTag} already recorded as ${seen.reference} — duplicate delivery ignored`,
      );
      return;
    }
  }

  // 2. Anything that isn't an accepted credit: persist + hold, change nothing.
  if (status !== "successful") {
    const reference = await persistVaSettlementStub({
      payload,
      matchStatus: "unmatched",
      amount,
      ours,
      gatewayRef,
      settledAt: paidAt,
      payerName,
      payerAccount,
      payerBank,
    });
    console.warn(
      `[gpay.va] ${logTag} reported status "${status}" — stored as ${reference}, nothing confirmed`,
    );
    await notifyTreasuryReconciliation(
      notifyVars(`unmatched (gateway status "${status}")`, reference),
    );
    return;
  }

  // 3. Unmapped service_code — we cannot know which pending payment this was.
  if (!ours) {
    const reference = await persistVaSettlementStub({
      payload,
      matchStatus: "unmatched",
      ours: null,
      amount,
      gatewayRef,
      settledAt: paidAt,
      payerName,
      payerAccount,
      payerBank,
    });
    console.warn(
      `[gpay.va] ${logTag} for unmapped service_code "${gpayServiceCode}" — stored as ${reference}`,
    );
    await notifyTreasuryReconciliation(
      notifyVars(
        `unmatched (unmapped service_code "${gpayServiceCode}")`,
        reference,
      ),
    );
    return;
  }

  // 4. Candidates: pending transfers for THIS service in the window ending at
  //    paid_at and reaching back 72h, then filtered on exact amount.
  //
  //    `paid_at` carries NO sub-second component ("14:30:00"), so the parsed
  //    timestamp is the start of that second. Comparing `createdAt <= paid_at`
  //    literally would reject a payment created even 1ms later in the same
  //    second — a citizen who transfers immediately after being handed their
  //    reference would be falsely reported as unmatched. Treat the whole
  //    reported second as valid.
  const settledAt = paidAt ?? new Date();
  const windowEnd = new Date(settledAt.getTime() + 999);
  const windowStart = new Date(settledAt.getTime() - VA_LOOKBACK_MS);

  const rows = await prisma.payment.findMany({
    where: {
      status: "pending",
      method: { in: ["bank_transfer", "virtual_account"] },
      createdAt: { gte: windowStart, lte: windowEnd },
      OR: [
        { serviceCode: ours },
        { invoice: { is: { service: { code: ours } } } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, reference: true, amount: true, createdAt: true },
  });

  const candidates = rows.filter((row) => sameAmount(row.amount, amount));

  // 5a. Exactly one → attach the evidence. Status stays `pending` throughout;
  //     confirming the payment is the treasurer's call, never ours.
  if (candidates.length === 1) {
    const target = candidates[0];
    await prisma.payment.update({
      where: { id: target.id },
      data: {
        gatewayRef: gatewayRef || null,
        payerName: payerName || null,
        payerAccount: payerAccount || null,
        payerBank: payerBank || null,
        settledAt: paidAt,
        matchStatus: "matched",
        serviceCode: ours,
        rawPayload: (payload ?? null) as any,
      },
    });
    console.log(
      `[gpay.va] ${logTag} matched ${target.reference} (NGN ${amount}) — awaiting treasurer confirmation`,
    );
    await notifyTreasuryReconciliation(notifyVars("matched", target.reference));
    return;
  }

  // 5b. Zero or 2+ → record it and hand it to a human. NOTHING else changes.
  const matchStatus = candidates.length === 0 ? "unmatched" : "ambiguous";
  const reference = await persistVaSettlementStub({
    payload,
    matchStatus,
    amount,
    ours,
    gatewayRef,
    settledAt: paidAt,
    payerName,
    payerAccount,
    payerBank,
  });

  if (candidates.length === 0) {
    console.warn(
      `[gpay.va] ${logTag} — no pending ${ours} payment matched NGN ${amount}; stored as ${reference}`,
    );
    await notifyTreasuryReconciliation(
      notifyVars("unmatched (no candidate)", reference),
    );
  } else {
    console.warn(
      `[gpay.va] ${logTag} — ${candidates.length} candidates matched NGN ${amount}; ambiguous, stored as ${reference}`,
    );
    await notifyTreasuryReconciliation(
      notifyVars(`ambiguous (${candidates.length} candidates)`, reference),
    );
  }
}




