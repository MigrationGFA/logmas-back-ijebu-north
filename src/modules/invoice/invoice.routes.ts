// invoices.routes.ts



import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { requireAuth } from '../../middleware/auth.middleware';
import {
  getInvoiceById,
  getInvoicesHubOverview,
  recordInvoicePayment,
  uploadInvoicePaymentProof,
} from './invoice.controller';
import { validateBody } from '../../middleware/validate.middleware';
import z from 'zod';
import { initializePaystackPayment, initializePaystackPaymentNewFlow } from '../payment/paystack.controller';
import { getInvoiceVirtualAccount } from '../payment/gpay.controller';
import { UPLOAD_FOLDER_MAP, ensureDirectoryExists } from '../../utils/fileStorage';

const router = Router();

// Proof-of-payment storage for POST /:invoiceNumber/payment-proof — same shape
// as the field-officer proof upload (5 MB, proof-<ts>-<hex><ext>).
const proofStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const targetFolder = UPLOAD_FOLDER_MAP.paymentProofs;
    ensureDirectoryExists(targetFolder);
    cb(null, targetFolder);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const ext = path.extname(file.originalname);
    cb(null, `proof-${uniqueSuffix}${ext}`);
  },
});
const proofUpload = multer({ storage: proofStorage, limits: { fileSize: 5 * 1024 * 1024 } });
// invoices.validation.ts
export const recordPaymentSchema = z.object({
  method:    z.enum(['pos', 'cash']),
  amount:    z.number().positive().optional(), // if not provided uses full balance
  reference: z.string().optional(),
  narration: z.string().optional(),
});


export default router;
router.get('/hub', requireAuth, getInvoicesHubOverview);

// Reserved virtual account details for this invoice. Registered BEFORE /:id
// so it can never be swallowed by the generic invoice route. Same handler is
// also mounted from gpay.routes.ts — both URLs work during rollout.
router.get(
  '/:invoiceNumber/virtual-account',
  requireAuth,
  getInvoiceVirtualAccount,
);

// Citizen/staff proof of a manual bank transfer. Registered before the
// generic /:id routes so the literal `payment-proof` segment can never be
// swallowed. Records the proof on the invoice's pending bank_transfer Payment
// and parks the application for the treasurer's Payment Confirmations
// worklist — it NEVER confirms the payment itself.
router.post(
  '/:invoiceNumber/payment-proof',
  requireAuth,
  proofUpload.single('proof'),
  uploadInvoicePaymentProof,
);

router.get('/:id',              requireAuth, getInvoiceById);
router.post('/:id/pay',         requireAuth, validateBody(recordPaymentSchema), recordInvoicePayment);
router.post("/:id/pay-online", requireAuth, initializePaystackPayment);
router.post("/public/initialize",  initializePaystackPaymentNewFlow);
// router.post('/:id/send-payment-link', requireAuth, sendPaymentLinkToBusiness);
// router.post('/:id/simulate-payment', requireAuth, simulatePayment); // dev only — remove in prod