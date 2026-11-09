// src/modules/payment/gpay.routes.ts
import { Router } from "express";
import express from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import { z } from "zod";

import { requireAuth } from "../../middleware/auth.middleware";
import { validateBody, validateQuery } from "../../middleware/validate.middleware";
import { UPLOAD_FOLDER_MAP, ensureDirectoryExists } from "../../utils/fileStorage";
import {
  getInvoiceVirtualAccount,
  getVirtualAccountForService,
  gpayWebhook,
  initializeGpayInvoicePayment,
  initializeGpayPublicPayment,
  submitPublicStaticTransferNotice,
  verifyGpayPayment,
} from "./gpay.controller";

const router = Router();

const jsonBody = express.json();

const proofStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const targetFolder = UPLOAD_FOLDER_MAP.paymentProofs;
    ensureDirectoryExists(targetFolder);
    cb(null, targetFolder);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const ext = path.extname(file.originalname);
    cb(null, `proof-${uniqueSuffix}${ext}`);
  },
});
const proofUpload = multer({ storage: proofStorage, limits: { fileSize: 5 * 1024 * 1024 } });

export const gpayPublicInitializeSchema = z.object({
  serviceId: z.string().min(1),
  fullName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(7),
});

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
// PUBLIC. Dedicated Providus Bank Static Virtual Account for the service (Channel 1).
router.get(
  "/virtual-account",
  virtualAccountLimiter,
  validateQuery(gpayVirtualAccountQuerySchema),
  getVirtualAccountForService,
);

// POST /api/v1/payments/gpay/static-transfer/public
// PUBLIC Channel 1 ("I Have Paid" + Optional Proof Upload):
// Records the citizen's application + invoice in "Payment Verification in Progress"
// (`awaiting_payment_confirmation`), attaches optional proof, and auto-confirms if
// the Providus webhook already settled.
router.post(
  "/static-transfer/public",
  virtualAccountLimiter,
  proofUpload.single("proof"),
  submitPublicStaticTransferNotice,
);

// GET /api/v1/payments/gpay/invoices/:invoiceNumber/virtual-account
router.get(
  "/invoices/:invoiceNumber/virtual-account",
  requireAuth,
  getInvoiceVirtualAccount,
);

// POST /api/v1/payments/gpay/webhook — GPay / Providus webhook
router.post("/webhook", express.raw({ type: "application/json" }), gpayWebhook);

// GET /api/v1/payments/gpay/verify/:reference
// Public: Channel 2 GPay Hosted Checkout verification
router.get("/verify/:reference", verifyGpayPayment);

// POST /api/v1/payments/gpay/public/initialize
// Public Channel 2: GPay Hosted Checkout for Instant Card / Online Payments
router.post(
  "/public/initialize",
  jsonBody,
  validateBody(gpayPublicInitializeSchema),
  initializeGpayPublicPayment,
);

// POST /api/v1/payments/gpay/initialize/:invoiceNumber
// Authenticated Channel 2: GPay Hosted Checkout for an existing invoice
router.post(
  "/initialize/:invoiceNumber",
  jsonBody,
  requireAuth,
  initializeGpayInvoicePayment,
);

export default router;
