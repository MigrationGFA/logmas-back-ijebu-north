// src/modules/fieldOfficer/fieldOfficer.controller.ts
import { Request, Response, NextFunction } from "express";
import { prisma } from "../../utils/prisma";
import { sendSuccess, sendError } from "../../utils/response";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import multer from 'multer';
import {
  generateReceiptNumber,
  generateVerificationCode,
  generateQrToken,
  generateReference,
} from "../../utils/generators";
import {  PaymentMethod, Role } from "@prisma/client";
import * as ApplicationService from "../application/application.service";
import { getIp, queryString } from "../complaints/complaints.controller";
import { findReservedAccount, SERVICE_CODE_BY_SERVICE } from "../payment/gpay.service";
import { notify } from "../notification/notification.service";

// ─────────────────────────────────────────────────────────────
// BUSINESS REGISTRATION
// ─────────────────────────────────────────────────────────────




// ─────────────────────────────────────────────────────────────
// INVOICE GENERATION
// ─────────────────────────────────────────────────────────────
// -----------------------------------------------------------------
// STATIC / RESERVED-ACCOUNT APPLICATION (field-officer-assisted)
// -----------------------------------------------------------------

/**
 * POST /api/v1/field-officer/applications
 * Field officer registers (or reuses) a citizen and submits an application on
 * their behalf, paid via the FO-only static/reserved bank account. The
 * application is parked at `awaiting_payment_confirmation` until a treasurer
 * reviews the uploaded proof - it never reaches `submitted` on its own.
 */
export const createStaticAccountApplication = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const officerId = req.user!.id;

    const {
      serviceId,
      formData,
      applicantId,
      firstName,
      lastName,
      email,
      phone,
    } = req.body;

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

    const gpayServiceCode = SERVICE_CODE_BY_SERVICE[service.code];
    if (!gpayServiceCode) {
      return sendError(
        res,
        "Bank transfer is not available for this service",
        "VIRTUAL_ACCOUNT_UNAVAILABLE",
        null,
        400,
      );
    }

    const account = await findReservedAccount(gpayServiceCode);
    if (!account) {
      return sendError(
        res,
        "No active transfer account is available for this service",
        "VIRTUAL_ACCOUNT_UNAVAILABLE",
        null,
        404,
      );
    }



    // ------------------------------------------------------------
    // Resolve the citizen applicant
    // ------------------------------------------------------------
    let citizenId = applicantId as string | undefined;
    let newCitizenCreated = false;
    let generatedPassword: string | null = null;
    let citizen: { id: string; email: string; firstName: string; lastName: string; phone: string | null } | null =
      null;

    if (citizenId) {
      citizen = await prisma.user.findUnique({
        where: { id: citizenId },
        select: { id: true, email: true, firstName: true, lastName: true, phone: true },
      });
      if (!citizen) {
        return sendError(res, "Applicant not found", "NOT_FOUND", null, 404);
      }
    } else {
      if (!firstName || !lastName || !email) {
        return sendError(
          res,
          "firstName, lastName and email are required to register a new citizen",
          "VALIDATION_ERROR",
          null,
          400,
        );
      }

      const normalizedEmail = String(email).toLowerCase().trim();
      const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });

      if (existing) {
        citizen = existing;
        citizenId = existing.id;
      } else {
        generatedPassword = crypto.randomBytes(6).toString("base64url");
        const hashedPassword = await bcrypt.hash(generatedPassword, 10);

        citizen = await prisma.user.create({
          data: {
            email: normalizedEmail,
            phone: phone ? String(phone).trim() : undefined,
            firstName,
            lastName,
            password: hashedPassword,
            role: "citizen",
            passwordResetRequired: true,
            isActive: true,
            emailVerifiedAt: new Date(),
          },
          select: { id: true, email: true, firstName: true, lastName: true, phone: true },
        });
        citizenId = citizen.id;
        newCitizenCreated = true;
      }
    }

    // ------------------------------------------------------------
    // Create the application + invoice (createInvoice defaults true)
    // ------------------------------------------------------------
    const { application, invoice } = await ApplicationService.createOrUpdateApplication({
      mode: "create",
      applicantId: citizenId,
      createdById: officerId,
      serviceId,
      formData: formData ?? {},
      files: [],
      createInvoice: true,
    });

    // Force the FO-assisted application into the confirmation-gated status —
    // `createOrUpdateApplication` always writes `submitted`.
    const gatedApplication = await prisma.application.update({
      where: { id: application.id },
      data: { status: "awaiting_payment_confirmation" },
    });

    // ------------------------------------------------------------
    // Record the pending static-account payment.
    // ------------------------------------------------------------
    const amount = Number(service.feeConfig.amount);
    const reference = generateReference("STA");

    const payment = await prisma.payment.create({
      data: {
        invoiceId: invoice?.id ?? null,
        amount,
        method: "bank_transfer" as PaymentMethod,
        status: "pending",
        reference,
        serviceCode: service.code,
        narration: `Field-officer static account — ${service.name}`,
      },
    });

    await prisma.auditLog.create({
      data: {
        action: "application_created",
        entity: "Application",
        entityId: application.id,
        userId: officerId,
        details: {
          flow: "field_officer_static_account",
          serviceId,
          applicantId: citizenId,
          newCitizenCreated,
          paymentId: payment.id,
        },
        ipAddress: getIp(req),
      },
    });


    if (newCitizenCreated && citizen) {
      try {
        await notify({
          userId: citizen.id,
          to: { email: citizen.email, phone: citizen.phone ?? "" },
          templateKey: "account.publicAccountCreated",
          vars: {
            applicant_name: `${citizen.firstName} ${citizen.lastName}`,
            application_number: gatedApplication.applicationNumber,
            service_name: service.name,
            application_id: application.id,
            fee_amount: amount.toString(),
            temp_password: generatedPassword,
          },
          channels: ["email", "sms"],
        });
      } catch (notifyErr) {
        console.error(
          "[createStaticAccountApplication] account notification failed, continuing:",
          notifyErr,
        );
      }
    }

    return sendSuccess(
      res,
      {
        application: gatedApplication,
        invoice,
        payment,
        transferInstructions: {
          bankName: account.bankName,
          accountNumber: account.accountNumber,
          accountName: account.accountName,
          amount,
          reference,
        },
        newCitizenCreated,
      },
      "Application submitted — awaiting payment confirmation",
      201,
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/field-officer/payments/:paymentId/proof
 * Field officer (or the citizen) uploads evidence of the static-account
 * transfer. Does NOT confirm the payment — that stays the treasurer's call.
 */
export const uploadPaymentProof = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const uploaderId = req.user!.id;
    let { paymentId } = req.params;
    if (Array.isArray(paymentId)) paymentId = paymentId[0];

    const file = (req as any).file as multer.File | undefined;
    if (!file) {
      return sendError(res, "A proof file is required", "VALIDATION_ERROR", null, 400);
    }

    const payment = await prisma.payment.findUnique({ where: { id: String(paymentId) } });
    if (!payment) {
      return sendError(res, "Payment not found", "NOT_FOUND", null, 404);
    }
    if (payment.status === "confirmed") {
      return sendError(res, "Payment is already confirmed", "BAD_REQUEST", null, 400);
    }

    const serverUrl = `${req.protocol}://${req.get("host")}`;
    const normalizedRelativePath = file.path.replace(/\\/g, "/");
    const proofUrl = `${serverUrl}/${normalizedRelativePath}`;

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        proofUrl,
        proofUploadedById: uploaderId,
        proofUploadedAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        action: "payment_confirmed",
        entity: "Payment",
        entityId: payment.id,
        userId: uploaderId,
        details: { event: "proof_uploaded", proofUrl },
        ipAddress: getIp(req),
      },
    });

    return sendSuccess(res, updated, "Proof of payment uploaded");
  } catch (err) {
    next(err);
  }
};



// ─────────────────────────────────────────────────────────────
// PAYMENT RECORDING
// ─────────────────────────────────────────────────────────────

/**
 * POST /api/v1/field-officer/payments
 * Field officer records a cash or POS payment against an invoice.
 * On full payment → receipt is auto-generated immediately.
 * On partial payment → invoice status set to partially_paid.
 */
export const recordPayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const officerId = req.user!.id;
    const actorRole = req.user!.role;

    // 1. Structural Parameter Sourcing
    let { invoiceId } = req.params;
    if (Array.isArray(invoiceId)) invoiceId = invoiceId[0];

    const { amount, method, reference, narration } = req.body;

    // Guard: Ensure only field collection agents can execute cash/POS settlements
    if (
      actorRole !== Role.field_officer &&
      actorRole !== Role.super_admin &&
      actorRole !== Role.lga_admin
    ) {
      return sendError(
        res,
        "Unauthorized operational clearance level",
        "FORBIDDEN",
        null,
        403,
      );
    }

    // 2. Fetch the Invoice and its payments (compute balance client-side)
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { payments: true, application: { include: { applicant: true, service: true } } },
    });

    if (!invoice)
      return sendError(res, "Invoice not found", "NOT_FOUND", null, 404);

    // Calculate existing paid amount
    const paidSoFar = invoice.payments?.reduce((s, p) => s + Number(p.amount ?? 0), 0) ?? 0;
    const invoiceTotal = Number(invoice.amount ?? 0);

    const paymentAmount = Number(amount);
    const balanceDue = Math.max(invoiceTotal - paidSoFar, 0);

    if (paymentAmount > balanceDue) {
      return sendError(
        res,
        `Collection value (₦${paymentAmount}) exceeds outstanding balance due (₦${balanceDue})`,
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const isFullPayment = paymentAmount >= balanceDue;
    const newAmountPaid = paidSoFar + paymentAmount;
    const newBalanceDue = Math.max(invoiceTotal - newAmountPaid, 0);

    // 3. EXECUTE ATOMIC TRANSACTION CONTEXT
    const result = await prisma.$transaction(async (tx) => {
      // A. Write standard transaction payment log
      const payment = await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          amount: paymentAmount,
          method: method as PaymentMethod,
          status: "confirmed",
          reference: reference || generateReference("PAY"),
          narration: narration || `Field collection`,
          confirmedAt: new Date(),
          confirmedById: officerId,
          paidById: invoice.createdById,
        },
      });

      // B. Update Invoice Balancing Properties
      const updatedInvoice = await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          paymentStatus: isFullPayment ? "confirmed" : invoice.paymentStatus,
          paidAt: isFullPayment ? new Date() : invoice.paidAt,
        },
      });

      let receipt = null;
      // C. Action triggers for Full Settlements
      if (isFullPayment) {
        // Generate security-backed printable receipt layout
        receipt = await tx.receipt.create({
          data: {
            receiptNumber: generateReceiptNumber("RCP"),
            verificationCode: generateVerificationCode(),
            qrToken: generateQrToken(),
            amountPaid: newAmountPaid,
            invoiceId: invoice.id,
            issuedById: officerId,
          },
        });
      }

      return { payment, invoice: updatedInvoice, receipt };
    });

    // 4. Trace Operations securely through background Audit Log chains
    await prisma.auditLog.create({
      data: {
        action: "payment_confirmed",
        entity: "Payment",
        entityId: result.payment.id,
        userId: officerId,
        details: {
          invoiceId: invoice.id,
          amount: paymentAmount,
          method,
          isFullPayment,
        },
        ipAddress: getIp(req),
      },
    });

    return sendSuccess(
      res,
      {
        payment: result.payment,
        invoice: result.invoice,
        receipt: result.receipt,
        message: isFullPayment
          ? "Payment processed fully. Receipt generated."
          : `Partial collection logged. Balance outstanding: ₦${newBalanceDue}`,
      },
      isFullPayment ? "Collection settled." : "Partial settlement recorded.",
    );
  } catch (err) {
    next(err);
  }
};


/**
 * POST /api/v1/operations/field/violations
 * Field officer logs a business violation or unregistered business.
 */
export const logViolation = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const officerId = req.user!.id;
    const {
      businessId, // optional — if business already registered
      businessName, // required if businessId not provided
      address, // required if businessId not provided
      wardId,
      description,
      severity = "minor",
    } = req.body;

    if (!description) {
      return sendError(
        res,
        "Description is required",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    if (!businessId && !businessName) {
      return sendError(
        res,
        "Either businessId or businessName is required",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    // Verify ward
    const ward = await prisma.ward.findUnique({ where: { id: wardId } });
    if (!ward) return sendError(res, "Ward not found", "NOT_FOUND", null, 404);

    // Create violation record. We do not enforce a separate Business model in the
    // current schema — store provided businessId/businessName as-is.
    const violation = await prisma.violation.create({
      data: {
        businessId: businessId ?? null,
        businessName: businessId ? null : businessName,
        address: businessId ? null : address,
        wardId,
        description,
        severity,
        status: "open",
        loggedById: officerId,
      },
      include: {
        ward: { select: { name: true } },
        loggedBy: { select: { firstName: true, lastName: true } },
      },
    });

    await prisma.auditLog.create({
      data: {
        action: "complaint_logged",
        entity: "Violation",
        entityId: violation.id,
        userId: officerId,
        details: {
          severity,
          businessName: businessId ? businessName ?? null : businessName,
        },
        ipAddress: getIp(req),
      },
    });

    return sendSuccess(res, violation, "Violation logged successfully", 201);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────
// RECEIPT VERIFICATION
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/field-officer/receipts/verify/:code
 * Field officer verifies a receipt in the field by code or QR token.
 */
export const verifyReceipt = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    // const { code } = req.params;
    const code = Array.isArray(req.params.code)
      ? req.params.code[0]
      : req.params.code;
    const officerId = req.user!.id;
    const cleanSearchCode = String(code).trim();

    const receipt = await prisma.receipt.findFirst({
      where: {
        OR: [
          { receiptNumber: cleanSearchCode }, // e.g., "RCP-2026-0001"
          { receiptNumber: cleanSearchCode.toUpperCase() },
          { verificationCode: code },
          { qrToken: code },
        ],
      },
      include: {
        invoice: {
          include: {
            application: {
              include: {
                applicant: { select: { id: true, firstName: true, lastName: true, email: true } },
                service: { select: { id: true, name: true, code: true } },
              },
            },
            payments: true,
          },
        },
        issuedBy: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    if (!receipt) {
      return sendError(
        res,
        "Receipt not found or invalid verification code",
        "NOT_FOUND",
        null,
        404,
      );
    }

    await prisma.auditLog.create({
      data: {
        action: "payment_confirmed",
        entity: "Receipt",
        entityId: receipt.id,
        userId: officerId,
        details: { verificationCode: code },
        ipAddress: getIp(req),
      },
    });

    const app = receipt.invoice.application;
    return sendSuccess(res, {
      valid: true,
      receiptNumber: receipt.receiptNumber,
      amountPaid: receipt.amountPaid,
      service: app?.service ? { id: app.service.id, name: app.service.name, code: app.service.code } : null,
      issuedAt: receipt.issuedAt,
      issuedBy: `${receipt.issuedBy.firstName} ${receipt.issuedBy.lastName}`,
      applicant: app?.applicant
        ? { id: app.applicant.id, name: `${app.applicant.firstName} ${app.applicant.lastName}`, email: app.applicant.email }
        : null,
      issuingAuthority: "Ijebu North East Local Government",
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────
// DAILY COLLECTIONS DASHBOARD
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/field-officer/collections
 * Field officer views their own collection history.
 * Scoped strictly to their own records — cannot see other officers.
 */
export const getMyCollections = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const officerId = req.user!.id;
    const date = queryString(req.query.date);
    // const category  = queryString(req.query.category) as RevenueCategory | undefined;
    const page = parseInt(queryString(req.query.page) ?? "1");
    const limit = parseInt(queryString(req.query.limit) ?? "20");
    const skip = (page - 1) * limit;

    // Build date filter — default to today if no date provided
    const targetDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
    const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

    const wherePayments: any = { confirmedById: officerId, createdAt: { gte: startOfDay, lte: endOfDay } };

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where: wherePayments,
        skip,
        take: limit,
        include: {
          invoice: {
            include: {
              application: { include: { service: true, applicant: true } },
              payments: true,
              receipts: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.payment.count({ where: wherePayments }),
    ]);

    // Daily summary totals (collected via payments)
    const summary = await prisma.payment.aggregate({ where: wherePayments, _sum: { amount: true }, _count: { _all: true } });

    return sendSuccess(res, {
      data: payments,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      summary: {
        totalCollected: summary._sum.amount ?? 0,
        totalTransactions: summary._count._all,
        date: startOfDay,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/field-officer/collections/summary
 * Aggregate summary of officer's collections — used for dashboard widgets.
 */
export const getCollectionSummary = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const officerId = req.user!.id;

    const today = new Date();
    const startOfToday = new Date(today.setHours(0, 0, 0, 0));

    // Use payments as source-of-truth for collections
    const [todaySummary, allTimeSummary, paymentsAll] = await Promise.all([
      prisma.payment.aggregate({ where: { confirmedById: officerId, createdAt: { gte: startOfToday } }, _sum: { amount: true }, _count: { _all: true } }),
      prisma.payment.aggregate({ where: { confirmedById: officerId }, _sum: { amount: true }, _count: { _all: true } }),
      prisma.payment.findMany({ where: { confirmedById: officerId }, include: { invoice: { include: { application: { include: { service: true } } } } } }),
    ]);

    // Group by service (by inspecting payment.invoice.application.service)
    const byServiceMap = new Map<string, { service: any; collected: number; transactions: number }>();
    for (const p of paymentsAll) {
      const svc = p.invoice?.application?.service;
      const key = svc ? svc.id : 'unknown';
      const entry = byServiceMap.get(key) ?? { service: svc ?? null, collected: 0, transactions: 0 };
      entry.collected += Number(p.amount ?? 0);
      entry.transactions += 1;
      byServiceMap.set(key, entry);
    }

    return sendSuccess(res, {
      today: {
        collected: todaySummary._sum.amount ?? 0,
        transactions: todaySummary._count._all,
      },
      allTime: {
        collected: allTimeSummary._sum.amount ?? 0,
        transactions: allTimeSummary._count._all,
      },
      byService: Array.from(byServiceMap.values()).map((v) => ({ service: v.service, collected: v.collected, transactions: v.transactions })),
    });
  } catch (err) {
    next(err);
  }
};
