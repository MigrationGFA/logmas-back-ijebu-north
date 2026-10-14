// src/modules/treasurer/treasurer.routes.ts
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRole } from "../../middleware/role.middleware";
import {
  validateBody,
  validateQuery,
} from "../../middleware/validate.middleware";
import {

  listServiceFees,
  getServiceFee,
  upsertServiceFee,
  getTreasuryOverview,
  getReconciliation,
  getFieldOfficersList,
  listAwaitingConfirmation,
  confirmStaticAccountPayment,
  declineStaticAccountPayment,

} from "./treasurer.controller";
import {
  createLevyConfigSchema,
  createPermitConfigSchema,
  listLevyConfigsSchema,
  listPermitConfigsSchema,
  updateLevyConfigSchema,
  updatePermitConfigSchema,
  upsertServiceFeeSchema,
  declinePaymentSchema,
} from "./treasurer.validation";

const router = Router();

/**
 * @openapi
 * tags:
 *   - name: Treasurer Operations
 *     description: Levy configuration management and revenue analytics for LGA Treasurer
 */

/**
 * @openapi
 * components:
 *   securitySchemes:
 *     BearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *   schemas:
 *     RevenueCategory:
 *       type: string
 *       enum: [market_taxes, tenement_rates, signboard_fees, livestock_fees, trade_permit, other_revenue]
 *     BillingCycle:
 *       type: string
 *       enum: [daily, weekly, monthly, yearly]
 *     InvoiceStatus:
 *       type: string
 *       enum: [draft, sent, paid, partially_paid, overdue, cancelled]
 *     DateRange:
 *       type: object
 *       properties:
 *         from:
 *           type: string
 *           format: date
 *         to:
 *           type: string
 *           format: date
 */

router.use(requireAuth);
router.get(
  "/field-officers",
  requireRole("agent", "lga_admin", "treasurer", "contractor"),
  getFieldOfficersList,
);

// Enforce strict treasury access - only treasurer, finance, or super admin
// router.use(requireRole("treasurer", "super_admin", "lga_admin"));

// ============================================================
// LEVY CONFIGURATION MANAGEMENT
// ============================================================


// ============================================================
// TREASURER SERVICE FEES (Odeda simplified flow)
// ============================================================


router.get('/fees', requireRole('treasurer'), listServiceFees);
router.get('/fees/:serviceId', requireRole('treasurer'), getServiceFee);
router.patch('/fees/:serviceId', requireRole('treasurer'), validateBody(upsertServiceFeeSchema), upsertServiceFee);

// ============================================================
// REVENUE ANALYTICS
// ============================================================

/**
 * @openapi
 * /treasurer/revenue:
 *   get:
 *     tags: [Treasurer Operations]
 *     summary: System-wide revenue overview
 *     description: Comprehensive revenue analytics including totals, category breakdown, status distribution, payment methods, and daily trends
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *         description: Start date for revenue period (defaults to start of current month)
 *         example: "2024-01-01"
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *         description: End date for revenue period (defaults to current date)
 *         example: "2024-12-31"
 *     responses:
 *       200:
 *         description: Revenue overview statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     period:
 *                       $ref: '#/components/schemas/DateRange'
 *                     summary:
 *                       type: object
 *                       properties:
 *                         totalInvoiced:
 *                           type: number
 *                         totalCollected:
 *                           type: number
 *                         totalOutstanding:
 *                           type: number
 *                         totalInvoices:
 *                           type: integer
 *                         collectionRate:
 *                           type: string
 *                           example: "75.5%"
 *                     byCategory:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           category:
 *                             type: string
 *                           invoiced:
 *                             type: number
 *                           collected:
 *                             type: number
 *                           invoiceCount:
 *                             type: integer
 *                     byStatus:
 *                       type: array
 *                     byPaymentMethod:
 *                       type: array
 *                     dailyTrend:
 *                       type: array
 */
router.get("/revenue", getTreasuryOverview);

// RECONCILIATION
// ============================================================

/**
 * @openapi
 * /treasurer/reconciliation:
 *   get:
 *     tags: [Treasurer Operations]
 *     summary: Invoice vs payment reconciliation report
 *     description: Detailed reconciliation showing what was issued, collected, and outstanding with full audit trail
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Reconciliation report
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     period:
 *                       $ref: '#/components/schemas/DateRange'
 *                     summary:
 *                       type: object
 *                       properties:
 *                         totalInvoiced:
 *                           type: number
 *                         totalCollected:
 *                           type: number
 *                         totalOutstanding:
 *                           type: number
 *                         variance:
 *                           type: number
 *                     data:
 *                       type: array
 *                       items:
 *                         type: object
 *                     meta:
 *                       type: object
 */
router.get("/reconciliation", getReconciliation);


// ============================================================
// FIELD-OFFICER STATIC-ACCOUNT PAYMENT CONFIRMATION
// ============================================================

/**
 * @openapi
 * /treasurer/applications/awaiting-confirmation:
 *   get:
 *     tags: [Treasurer Operations]
 *     summary: Applications parked pending treasurer confirmation of a field-officer static-account payment
 *     security:
 *       - BearerAuth: []
 */
router.get(
  "/applications/awaiting-confirmation",
  requireRole("treasurer", "super_admin"),
  listAwaitingConfirmation,
);

/**
 * @openapi
 * /treasurer/payments/{paymentId}/confirm:
 *   patch:
 *     tags: [Treasurer Operations]
 *     summary: Confirm a field-officer static-account payment and release the application for review
 *     security:
 *       - BearerAuth: []
 */
router.patch(
  "/payments/:paymentId/confirm",
  requireRole("treasurer", "super_admin"),
  confirmStaticAccountPayment,
);

/**
 * @openapi
 * /treasurer/payments/{paymentId}/decline:
 *   patch:
 *     tags: [Treasurer Operations]
 *     summary: Decline a field-officer static-account payment's proof and decline the application
 *     security:
 *       - BearerAuth: []
 */
router.patch(
  "/payments/:paymentId/decline",
  requireRole("treasurer", "super_admin"),
  validateBody(declinePaymentSchema),
  declineStaticAccountPayment,
);

export default router;
