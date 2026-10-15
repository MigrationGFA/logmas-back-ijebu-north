// src/modules/payment/gpay.routes.ts
import { Router } from "express";
import express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { requireAuth } from "../../middleware/auth.middleware";
import { validateBody, validateQuery } from "../../middleware/validate.middleware";
import {
  createDynamicAccountForInvoice,
  createDynamicAccountPublicPayment,
  getInvoiceVirtualAccount,
  getVirtualAccountForService,
  gpayWebhook,
  initializeGpayInvoicePayment,
  initializeGpayPublicPayment,
  verifyDynamicAccountPayment,
  verifyGpayPayment,
} from "./gpay.controller";

const router = Router();

// Parsing is attached per-route because this router is mounted BEFORE the global
// express.json() in app.ts. That ordering is deliberate: `/webhook` needs the
// raw request bytes for HMAC verification, and once express.json() has consumed
// the stream the raw body is gone for good.
const jsonBody = express.json();

export const gpayPublicInitializeSchema = z.object({
  serviceId: z.string().min(1),
  fullName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(7),
});

// The public virtual-account endpoint is hit on every payment page load, so it
// gets its own bucket — a burst there must not exhaust the global limiter for
// the rest of the site. Same response shape as the other limiters.
const virtualAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "error",
    error: {
      code: "TOO_MANY_REQUESTS",
      message:
        "Too many requests for bank transfer details. Please try again in 15 minutes.",
      details: null,
    },
  },
});

export const gpayVirtualAccountQuerySchema = z.object({
  serviceId: z.string().min(1),
});

// GET /api/v1/payments/gpay/virtual-account?serviceId=
// PUBLIC. Asks for the service identity only; the account itself is resolved
// server side. GET, so no body parser is needed on this route.
router.get(
  "/virtual-account",
  virtualAccountLimiter,
  validateQuery(gpayVirtualAccountQuerySchema),
  getVirtualAccountForService,
);

// GET /api/v1/payments/gpay/invoices/:invoiceNumber/virtual-account
// The same handler is also mounted from invoice.routes.ts at
// /api/v1/invoices/:invoiceNumber/virtual-account — both URLs work.
router.get(
  "/invoices/:invoiceNumber/virtual-account",
  requireAuth,
  getInvoiceVirtualAccount,
);

// GET /api/v1/payments/gpay/dynamic-account/verify/:reference
// Public poll for a minted transfer account — the frontend hits this while
// the expiry countdown runs (webhook is the primary settlement signal).
router.get("/dynamic-account/verify/:reference", verifyDynamicAccountPayment);

// POST /api/v1/payments/gpay/dynamic-account/invoices/:invoiceNumber
// Authenticated invoice payment by one-shot transfer account (15-min expiry).
router.post(
  "/dynamic-account/invoices/:invoiceNumber",
  jsonBody,
  requireAuth,
  createDynamicAccountForInvoice,
);

// POST /api/v1/payments/gpay/dynamic-account/public
// Public "apply + pay first" flow via one-shot transfer account.
router.post(
  "/dynamic-account/public",
  jsonBody,
  validateBody(gpayPublicInitializeSchema),
  createDynamicAccountPublicPayment,
);

// POST /api/v1/payments/gpay/webhook — GPay calls this. Signature verification
// happens inside gpayWebhook, so no auth middleware here.
router.post("/webhook", express.raw({ type: "application/json" }), gpayWebhook);

// GET /api/v1/payments/gpay/verify/:reference✅
// Public: the frontend calls this on refresh / after the redirect back from the
// checkout page.
router.get("/verify/:reference", verifyGpayPayment);

// POST /api/v1/payments/gpay/public/initialize
// Public "apply + pay first" flow — mirrors /api/v1/invoices/public/initialize
router.post(
  "/public/initialize",
  jsonBody,
  validateBody(gpayPublicInitializeSchema),
  initializeGpayPublicPayment,
);

// POST /api/v1/payments/gpay/initialize/:invoiceNumber
// Authenticated invoice payment — mirrors /api/v1/invoices/:id/pay-online
router.post(
  "/initialize/:invoiceNumber",
  jsonBody,
  requireAuth,
  initializeGpayInvoicePayment,
);

export default router;
