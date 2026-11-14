import { fetchFieldOfficerMetrics } from "./field-officer-metrics";
// src/modules/treasurer/treasurer.controller.ts
import { Request, Response, NextFunction } from "express";
import { prisma } from "../../utils/prisma";
import { sendSuccess, sendError } from "../../utils/response";
import { InvoiceStatus, Prisma } from "@prisma/client";
import { getIp, queryString } from "../complaints/complaints.controller";
import { upsertServiceFeeSchema } from "./treasurer.validation";
import { generateReceiptNumber, generateVerificationCode, generateQrToken } from "../../utils/generators";
import { notify } from "../notification/notification.service";


const buildDateRange = (from?: string, to?: string) => {
  const now = new Date();

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  return {
    gte: from ? new Date(from) : startOfMonth,
    lte: to ? new Date(to) : now,
  };
};

export const getTreasuryOverview = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const from =
      typeof req.query.from === "string" ? req.query.from : undefined;

    const to = typeof req.query.to === "string" ? req.query.to : undefined;

    const dateRange = buildDateRange(from, to);

    const [
      invoiceSummary,
      paymentSummary,
      paymentMethods,
      applicationStatuses,
      serviceRevenue,
      recentPayments,
    ] = await Promise.all([
      // --------------------------------------------------
      // INVOICE SUMMARY
      // --------------------------------------------------
      prisma.invoice.aggregate({
        where: {
          createdAt: dateRange,
        },
        _sum: {
          amount: true,
        },
        _count: {
          _all: true,
        },
      }),

      // --------------------------------------------------
      // PAYMENT SUMMARY
      // --------------------------------------------------
      prisma.payment.aggregate({
        where: {
          createdAt: dateRange,
        },
        _sum: {
          amount: true,
        },
        _count: {
          _all: true,
        },
      }),

      // --------------------------------------------------
      // PAYMENT METHOD BREAKDOWN
      // --------------------------------------------------
      prisma.payment.groupBy({
        by: ["method"],
        where: {
          createdAt: dateRange,
          status: "confirmed",
        },
        _sum: {
          amount: true,
        },
        _count: {
          _all: true,
        },
      }),

      // --------------------------------------------------
      // APPLICATION STATUS BREAKDOWN
      // --------------------------------------------------
      prisma.application.groupBy({
        by: ["status"],
        where: {
          createdAt: dateRange,
        },
        _count: {
          _all: true,
        },
      }),

      // --------------------------------------------------
      // REVENUE BY SERVICE
      // --------------------------------------------------
      prisma.payment.findMany({
        where: {
          createdAt: dateRange,
          status: "confirmed",
        },
        select: {
          amount: true,
          invoice: {
            select: {
              application: {
                select: {
                  service: {
                    select: {
                      id: true,
                      name: true,
                      code: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),

      // --------------------------------------------------
      // RECENT PAYMENTS
      // --------------------------------------------------
      prisma.payment.findMany({
        where: {
          createdAt: dateRange,
        },
        orderBy: {
          createdAt: "desc",
        },
        take: 10,
        select: {
          id: true,
          amount: true,
          method: true,
          status: true,
          reference: true,
          gatewayRef: true,
          createdAt: true,
          confirmedAt: true,

          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
              amount: true,

              application: {
                select: {
                  applicationNumber: true,
                  fullName: true,

                  service: {
                    select: {
                      name: true,
                      code: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ]);

    // --------------------------------------------------
    // CALCULATE CONFIRMED COLLECTION
    // --------------------------------------------------

    const confirmedPaymentSummary = await prisma.payment.aggregate({
      where: {
        createdAt: dateRange,
        status: "confirmed",
      },
      _sum: {
        amount: true,
      },
      _count: {
        _all: true,
      },
    });

    const totalInvoiced = Number(invoiceSummary._sum.amount ?? 0);

    const totalCollected = Number(confirmedPaymentSummary._sum.amount ?? 0);

    const totalOutstanding = Math.max(totalInvoiced - totalCollected, 0);

    const collectionRate =
      totalInvoiced > 0
        ? Number(((totalCollected / totalInvoiced) * 100).toFixed(2))
        : 0;

    // --------------------------------------------------
    // REVENUE BY SERVICE
    // --------------------------------------------------

    const serviceMap = new Map<
      string,
      {
        serviceId: string;
        serviceName: string;
        serviceCode: string;
        totalCollected: number;
        transactions: number;
      }
    >();

    for (const payment of serviceRevenue) {
      const service = payment.invoice.application.service;

      const existing = serviceMap.get(service.id);

      if (existing) {
        existing.totalCollected += Number(payment.amount);
        existing.transactions += 1;
      } else {
        serviceMap.set(service.id, {
          serviceId: service.id,
          serviceName: service.name,
          serviceCode: service.code,
          totalCollected: Number(payment.amount),
          transactions: 1,
        });
      }
    }

    const revenueByService = Array.from(serviceMap.values()).sort(
      (a, b) => b.totalCollected - a.totalCollected,
    );

    return sendSuccess(res, {
      period: {
        from: dateRange.gte,
        to: dateRange.lte,
      },

      summary: {
        totalInvoices: invoiceSummary._count._all,
        totalInvoiced,
        totalCollected,
        totalOutstanding,
        collectionRate: `${collectionRate}%`,
        confirmedTransactions: confirmedPaymentSummary._count._all,
        totalPaymentTransactions: paymentSummary._count._all,
      },

      paymentMethods: paymentMethods.map((item) => ({
        method: item.method,
        totalCollected: Number(item._sum.amount ?? 0),
        transactions: item._count._all,
      })),

      applicationStatuses: applicationStatuses.map((item) => ({
        status: item.status,
        count: item._count._all,
      })),

      revenueByService,

      recentPayments,
    });
  } catch (error) {
    next(error);
  }
};
/**
 * GET /api/v1/treasurer/fees
 * Return all active services with their fee configuration (may be null)
 */
export const listServiceFees = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const services = await prisma.service.findMany({
      where: { isActive: true },
      include: { feeConfig: true },
      orderBy: { name: "asc" },
    });

    return sendSuccess(res, services);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/treasurer/fees/:serviceId
 */
export const getServiceFee = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { serviceId } = req.params;
    const service = await prisma.service.findUnique({
      where: { id: String(serviceId) },
      include: {
        feeConfig: {
          include: {
            updatedBy: {
              select: { id: true, firstName: true, lastName: true },
            },
          },
        },
      },
    });

    if (!service)
      return sendError(res, "Service not found", "NOT_FOUND", null, 404);
    if (!service.isActive)
      return sendError(res, "Service is not active", "BAD_REQUEST", null, 400);

    return sendSuccess(res, service);
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/v1/treasurer/fees/:serviceId
 * Create or update ServiceFeeConfig for the service
 */

export const upsertServiceFee = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const treasurerId = req.user!.id;
    const { serviceId } = req.params;

    // Validate payload
    const parsed = upsertServiceFeeSchema.safeParse(req.body);
    if (!parsed.success)
      return sendError(
        res,
        "Invalid request body",
        "VALIDATION_ERROR",
        parsed.error.format(),
        400,
      );

    const { amount, status, layerDepth, billingUnit, effectiveDate, expiryDate, pricingTiers } = parsed.data;
    const statusEnum = status ? "ACTIVE" : "INACTIVE";
    const extraFeeData: any = {
      ...(layerDepth !== undefined && { layerDepth }),
      ...(billingUnit !== undefined && { billingUnit }),
      ...(effectiveDate !== undefined && { effectiveDate: effectiveDate ? new Date(effectiveDate) : null }),
      ...(expiryDate !== undefined && { expiryDate: expiryDate ? new Date(expiryDate) : null }),
      ...(pricingTiers !== undefined && { pricingTiers: pricingTiers ?? Prisma.JsonNull }),
    };

    // Verify service
    const service = await prisma.service.findUnique({
      where: { id: String(serviceId) },
    });
    if (!service)
      return sendError(res, "Service not found", "NOT_FOUND", null, 404);
    if (!service.isActive)
      return sendError(res, "Service is not active", "BAD_REQUEST", null, 400);

    // Upsert fee config
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.serviceFeeConfig.findUnique({
        where: { serviceId: service.id },
      });

      if (existing) {
        const updated = await tx.serviceFeeConfig.update({
          where: { serviceId: service.id },
          data: {
            amount,
            updatedById: treasurerId,
            status: statusEnum,
            ...extraFeeData,
          },
          include: {
            updatedBy: {
              select: { id: true, firstName: true, lastName: true },
            },
          },
        });

        await tx.service.update({
          where: { id: String(service.id) },
          data: {
            isActive: statusEnum === "ACTIVE" ? true : false,
          },
        });

        await tx.auditLog.create({
          data: {
            action: "pricing_updated",
            entity: "ServiceFeeConfig",
            entityId: updated.id,
            userId: treasurerId,
            details: {
              before: { amount: existing.amount, status: existing.status },
              after: { amount, status: statusEnum },
            },
            ipAddress: getIp(req),
          },
        });

        return updated;
      }

      const created = await tx.serviceFeeConfig.create({
        data: {
          serviceId: service.id,
          amount,
          status: statusEnum,
          updatedById: treasurerId,
          ...extraFeeData,
        },
        include: {
          updatedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      });

      await tx.auditLog.create({
        data: {
          action: "pricing_updated",
          entity: "ServiceFeeConfig",
          entityId: created.id,
          userId: treasurerId,
          details: { created: { amount, status: statusEnum } },
          ipAddress: getIp(req),
        },
      });

      return created;
    });

    return sendSuccess(res, result, "Service fee configured");
  } catch (err) {
    next(err);
  }
};

export const getReconciliation = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const from =
      typeof req.query.from === "string" ? req.query.from : undefined;

    const to = typeof req.query.to === "string" ? req.query.to : undefined;

    const page = Math.max(Number(req.query.page ?? 1), 1);

    const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);

    const skip = (page - 1) * limit;

    const dateRange = buildDateRange(from, to);

    const where = {
      createdAt: dateRange,
    };

    const [invoices, total, invoiceSummary] = await Promise.all([
      prisma.invoice.findMany({
        where,
        skip,
        take: limit,

        orderBy: {
          createdAt: "desc",
        },

        select: {
          id: true,
          invoiceNumber: true,
          amount: true,
          paymentStatus: true,
          virtualBankName: true,
          virtualAccountNumber: true,
          virtualAccountRef: true,
          transactionRef: true,
          paidAt: true,
          createdAt: true,

          application: {
            select: {
              id: true,
              applicationNumber: true,
              fullName: true,
              phone: true,
              email: true,

              service: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  category: true,
                },
              },
            },
          },

          payments: {
            select: {
              id: true,
              amount: true,
              method: true,
              status: true,
              reference: true,
              gatewayRef: true,
              confirmedAt: true,
              createdAt: true,
            },

            orderBy: {
              createdAt: "asc",
            },
          },

          receipts: {
            select: {
              id: true,
              receiptNumber: true,
              verificationCode: true,
              amountPaid: true,
              issuedAt: true,
            },
          },
        },
      }),

      prisma.invoice.count({
        where,
      }),

      prisma.invoice.aggregate({
        where,
        _sum: {
          amount: true,
        },
      }),
    ]);

    // --------------------------------------------------
    // RECONCILE EACH INVOICE
    // --------------------------------------------------

    const reconciliation = invoices.map((invoice) => {
      const confirmedPayments = invoice.payments.filter(
        (payment) => payment.status === "confirmed",
      );

      const totalCollected = confirmedPayments.reduce(
        (sum, payment) => sum + Number(payment.amount),
        0,
      );

      const invoiceAmount = Number(invoice.amount);

      const outstanding = Math.max(invoiceAmount - totalCollected, 0);

      return {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,

        application: invoice.application,

        invoiceAmount,

        paymentStatus: invoice.paymentStatus,

        totalCollected,

        outstanding,

        paymentCount: invoice.payments.length,

        confirmedPaymentCount: confirmedPayments.length,

        payments: invoice.payments,

        receipts: invoice.receipts,

        virtualAccount: {
          bankName: invoice.virtualBankName,
          accountNumber: invoice.virtualAccountNumber,
          reference: invoice.virtualAccountRef,
        },

        transactionRef: invoice.transactionRef,

        paidAt: invoice.paidAt,

        createdAt: invoice.createdAt,
      };
    });

    const totalInvoiced = Number(invoiceSummary._sum.amount ?? 0);

    const totalCollected = reconciliation.reduce(
      (sum, invoice) => sum + invoice.totalCollected,
      0,
    );

    const totalOutstanding = Math.max(totalInvoiced - totalCollected, 0);

    return sendSuccess(
      res,
      {
        period: {
          from: dateRange.gte,
          to: dateRange.lte,
        },

        summary: {
          totalInvoiced,
          totalCollected,
          totalOutstanding,
          variance: totalInvoiced - totalCollected,
          invoiceCount: total,
        },

        data: reconciliation,
      },

      {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    );
  } catch (error) {
    next(error);
  }
};

export const getFieldOfficersList = async (req: Request, res: Response) => {
  try {
    const { id: userId, role } = req.user!;

    const { stats, officers: mappedOfficers } = await fetchFieldOfficerMetrics(
      role === "contractor" || role === "agent" ? userId : undefined,
    );

    return res.status(200).json({
      success: true,
      data: {
        stats,
        officers: mappedOfficers,
      },
    });
  } catch (error) {
    console.error("Error fetching field personnel list:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ============================================================
// FIELD-OFFICER STATIC-ACCOUNT PAYMENT CONFIRMATION
// ============================================================

/**
 * GET /api/v1/treasurer/applications/awaiting-confirmation
 * Worklist of applications parked at `awaiting_payment_confirmation` —
 * the sole signal that a field-officer-assisted static-account payment is
 * waiting on treasurer review.
 */
export const listAwaitingConfirmation = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 25;

    const status = String(req.query.status || "pending");
    const paymentWhere: Prisma.PaymentWhereInput = {
      method: "bank_transfer",
      ...(status === "confirmed" ? { status: "confirmed" } :
          status === "rejected" ? { matchStatus: "rejected" } :
          status === "pending" ? { status: "pending", NOT: { matchStatus: "rejected" } } : {}),
    };
    const where: Prisma.ApplicationWhereInput = {
      invoice: { is: { payments: { some: paymentWhere } } },
    };

    const [items, total] = await Promise.all([
      prisma.application.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          service: true,
          invoice: { include: { payments: { where: paymentWhere, orderBy: { createdAt: "desc" }, include: { proofUploadedBy: { select: { id: true, firstName: true, lastName: true } } } } } },
          applicant: {
            select: { id: true, firstName: true, lastName: true, email: true, phone: true },
          },
          createdBy: {
            select: { id: true, firstName: true, lastName: true, role: true },
          },
        },
      }),
      prisma.application.count({ where }),
    ]);

    return sendSuccess(res, {
      data: items,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};


/**
 * PATCH /api/v1/treasurer/payments/:paymentId/confirm
 * Treasurer confirms a field-officer static-account payment: marks the
 * Payment confirmed, settles the invoice, generates a receipt, and releases
 * the application back to `submitted` so the normal review pipeline picks
 * it up.
 */
export const confirmStaticAccountPayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const treasurerId = req.user!.id;
    let { paymentId } = req.params;
    if (Array.isArray(paymentId)) paymentId = paymentId[0];

    const payment = await prisma.payment.findUnique({
      where: { id: String(paymentId) },
      include: {
        invoice: {
          include: { application: { include: { applicant: true, service: true } } },
        },
      },
    });

    if (!payment) {
      return sendError(res, "Payment not found", "NOT_FOUND", null, 404);
    }
    if (payment.status === "confirmed") {
      return sendError(res, "Payment is already confirmed", "BAD_REQUEST", null, 400);
    }

    const application = payment.invoice?.application;
    if (!application || application.status !== "awaiting_payment_confirmation") {
      return sendError(
        res,
        "Application is not awaiting payment confirmation",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    // FO-only collections may also be cash: the officer collected out of
    // band and the treasurer's confirmation is the control point.
    const isFoOnlyService = application.service?.foOnly === true;
    if (
      !["bank_transfer", "virtual_account"].includes(payment.method) &&
      !(isFoOnlyService && payment.method === "cash")
    ) {
      return sendError(res, "Upload payment proof before confirmation", "BAD_REQUEST", null, 400);
    }

    const { overrideUnderpayment, underpaymentReason } = req.body || {};
    const expectedFee = Number(payment.invoice?.amount || 0);
    const actualFee = Number(payment.amount || 0);
    if (expectedFee > 0 && actualFee < expectedFee - 0.01 && !overrideUnderpayment) {
      return sendError(
        res,
        `Underpayment detected: Received amount (₦${actualFee.toLocaleString()}) is less than statutory fee (₦${expectedFee.toLocaleString()}). Shortfall is ₦${(expectedFee - actualFee).toLocaleString()}. Confirmation blocked to prevent revenue loss.`,
        "UNDERPAYMENT_DETECTED",
        { expectedFee, actualFee, shortfall: expectedFee - actualFee },
        400,
      );
    }

    const invoiceId = payment.invoiceId!;

    const result = await prisma.$transaction(async (tx) => {
      const confirmedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: "confirmed",
          confirmedById: treasurerId,
          confirmedAt: new Date(),
          matchStatus: "matched",
        },
      });

      const updatedInvoice = await tx.invoice.update({
        where: { id: invoiceId },
        data: { paymentStatus: "confirmed", paidAt: new Date() },
      });

      const existingReceipt = await tx.receipt.findUnique({ where: { invoiceId } });
      const receipt =
        existingReceipt ??
        (await tx.receipt.create({
          data: {
            receiptNumber: generateReceiptNumber("RCP"),
            verificationCode: generateVerificationCode(),
            qrToken: generateQrToken(),
            amountPaid: confirmedPayment.amount,
            invoiceId,
            issuedById: treasurerId,
          },
        }));

      const updatedApplication = await tx.application.update({
        where: { id: application.id },
        data: {
          status: (() => {
            const fd = (application.formData && typeof application.formData === "object") ? (application.formData as Record<string, any>) : {};
            const metaKeys = new Set(["_publicTransferNotice", "subAdminPaymentReview", "subAdminReview", "applicantResubmission", "termsAccepted", "termsAcceptedAt", "fullName", "email", "phone"]);
            const hasServiceFields = !fd._publicTransferNotice && Object.keys(fd).some((k) => !metaKeys.has(k) && fd[k] !== undefined && fd[k] !== null && fd[k] !== "");
            return hasServiceFields ? "submitted" : "awaiting_form";
          })(),
        },
      });

      return { confirmedPayment, updatedInvoice, receipt, updatedApplication };
    });

    await prisma.auditLog.create({
      data: {
        action: "payment_confirmed",
        entity: "Payment",
        entityId: payment.id,
        userId: treasurerId,
        details: {
          flow: "field_officer_static_account",
          applicationId: application.id,
          invoiceId,
        },
        ipAddress: getIp(req),
      },
    });

    try {
      if (application.applicant) {
        await notify({
          userId: application.applicant.id,
          to: { email: application.applicant.email, phone: application.applicant.phone ?? "" },
          templateKey: "application.completeApplication",
          vars: {
            applicant_name: `${application.applicant.firstName} ${application.applicant.lastName}`,
            application_number: application.applicationNumber,
            service_name: application.service.name,
            application_id: application.id,
          },
          channels: ["email", "sms"],
        });
      }
    } catch (notifyErr) {
      console.error("[confirmStaticAccountPayment] notify() failed, continuing:", notifyErr);
    }

    // Alert the field officer who started this record (FO-only
    // collections and FO-assisted flows): the treasurer's confirmation
    // is the moment they are waiting on.
    try {
      const creatorId = application.createdById;
      if (creatorId && creatorId !== application.applicantId) {
        const creator = await prisma.user.findUnique({
          where: { id: creatorId },
          select: {
            id: true,
            role: true,
            email: true,
            phone: true,
            firstName: true,
            lastName: true,
          },
        });
        if (creator && creator.role === "field_officer") {
          await notify({
            userId: creator.id,
            to: { email: creator.email, phone: creator.phone ?? "" },
            templateKey: "application.foPaymentConfirmed",
            vars: {
              officer_name: `${creator.firstName} ${creator.lastName}`,
              service_name: application.service.name,
              amount: Number(payment.amount).toLocaleString("en-NG"),
              application_number: application.applicationNumber,
              invoice_number: payment.invoice?.invoiceNumber ?? "",
              receipt_number: result.receipt.receiptNumber,
            },
            channels: [],
          });
        }
      }
    } catch (foNotifyErr) {
      console.error("[confirmStaticAccountPayment] FO notify() failed, continuing:", foNotifyErr);
    }

    return sendSuccess(res, result, "Payment confirmed — application released for review");
  } catch (err) {
    next(err);
  }
};


/**
 * PATCH /api/v1/treasurer/payments/:paymentId/decline
 * Treasurer rejects the submitted proof (mismatched/invalid). The payment
 * stays pending with the proof cleared, and the application is declined with
 * the reason recorded — the citizen/FO can resubmit a new payment.
 */
export const declineStaticAccountPayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const treasurerId = req.user!.id;
    let { paymentId } = req.params;
    if (Array.isArray(paymentId)) paymentId = paymentId[0];
    const { reason } = req.body;

    if (!reason || !String(reason).trim()) {
      return sendError(res, "reason is required when declining a payment", "VALIDATION_ERROR", null, 400);
    }

    const payment = await prisma.payment.findUnique({
      where: { id: String(paymentId) },
      include: { invoice: { include: { application: { include: { applicant: true, service: true } } } } },
    });

    if (!payment) {
      return sendError(res, "Payment not found", "NOT_FOUND", null, 404);
    }

    const application = payment.invoice?.application;
    if (!application || application.status !== "awaiting_payment_confirmation") {
      return sendError(
        res,
        "Application is not awaiting payment confirmation",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          matchStatus: "rejected",
        },
      });

      const updatedApplication = await tx.application.update({
        where: { id: application.id },
        data: {
          status: "declined",
          reviewedById: treasurerId,
          reviewedAt: new Date(),
          declineReason: reason,
        },
      });

      return { updatedPayment, updatedApplication };
    });

    await prisma.auditLog.create({
      data: {
        action: "application_rejected",
        entity: "Payment",
        entityId: payment.id,
        userId: treasurerId,
        details: { flow: "field_officer_static_account", reason, applicationId: application.id },
        ipAddress: getIp(req),
      },
    });

    try {
      if (application.applicant) {
        await notify({
          userId: application.applicant.id,
          to: { email: application.applicant.email, phone: application.applicant.phone ?? "" },
          templateKey: "application.applicationDeclined",
          vars: {
            applicant_name: `${application.applicant.firstName} ${application.applicant.lastName}`,
            application_number: application.applicationNumber,
            service_name: application.service.name,
            application_id: application.id,
            decline_reason: reason,
            reviewed_at: new Date().toISOString(),
            reviewer_name: "Treasurer",
          },
          channels: ["email", "sms"],
        });
      }
    } catch (notifyErr) {
      console.error("[declineStaticAccountPayment] notify() failed, continuing:", notifyErr);
    }

    return sendSuccess(res, result, "Payment proof declined — application declined");
  } catch (err) {
    next(err);
  }
};


/**
 * PATCH /api/v1/treasurer/payments/:paymentId/sub-admin-review
 * Sub-Admin performs first-level verification of manual payment evidence before Treasurer final approval.
 */
export const subAdminReviewStaticAccountPayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const reviewerId = req.user!.id;
    let { paymentId } = req.params;
    if (Array.isArray(paymentId)) paymentId = paymentId[0];
    const { action, comment } = req.body || {};

    if (!["approve", "request_correction", "decline"].includes(action)) {
      return sendError(res, "action must be 'approve', 'request_correction', or 'decline'", "VALIDATION_ERROR", null, 400);
    }

    const payment = await prisma.payment.findUnique({
      where: { id: String(paymentId) },
      include: {
        invoice: {
          include: { application: { include: { applicant: true, service: true } } },
        },
      },
    });

    if (!payment) {
      return sendError(res, "Payment not found", "NOT_FOUND", null, 404);
    }

    const application = payment.invoice?.application;
    if (!application) {
      return sendError(res, "Associated application not found", "NOT_FOUND", null, 404);
    }

    const reviewer = await prisma.user.findUnique({
      where: { id: reviewerId },
      select: { firstName: true, lastName: true, role: true },
    });
    const reviewerName = reviewer ? `${reviewer.firstName} ${reviewer.lastName}` : "Sub-Admin";

    const existingFormData = (application.formData && typeof application.formData === "object")
      ? (application.formData as Record<string, any>)
      : {};

    const updatedFormData = {
      ...existingFormData,
      subAdminPaymentReview: {
        status: action === "approve"
          ? "approved_for_treasurer"
          : action === "decline"
          ? "declined"
          : "correction_requested",
        reviewedById: reviewerId,
        reviewerName,
        reviewedAt: new Date().toISOString(),
        comment: comment || (action === "approve"
          ? "Payment evidence verified by Sub-Admin — forwarded to Treasurer for final confirmation."
          : action === "decline"
          ? "Payment evidence declined by Sub-Admin."
          : "Please upload a clearer payment receipt or verify transfer details."),
      },
    };

    const result = await prisma.$transaction(async (tx) => {
      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          matchStatus: action === "approve"
            ? "sub_admin_approved"
            : action === "decline"
            ? "rejected"
            : "correction_requested",
        },
      });

      const updatedApplication = await tx.application.update({
        where: { id: application.id },
        data: {
          formData: updatedFormData,
          ...(action === "request_correction"
            ? {
                status: "correction_requested" as any,
                declineReason: comment || "Payment evidence requires correction",
              }
            : action === "decline"
            ? {
                status: "declined" as any,
                declineReason: comment || "Payment evidence declined by Sub-Admin",
              }
            : {}),
        },
      });

      return { updatedPayment, updatedApplication };
    });

    await prisma.auditLog.create({
      data: {
        action: action === "approve" ? "approval_granted" : action === "decline" ? "application_rejected" : "correction_requested",
        entity: "Payment",
        entityId: payment.id,
        userId: reviewerId,
        details: {
          stage: "sub_admin_payment_review",
          action,
          comment,
          applicationId: application.id,
        },
        ipAddress: getIp(req),
      },
    });

    try {
      if (application.applicant) {
        if (action === "approve") {
          await notify({
            userId: application.applicant.id,
            to: { email: application.applicant.email, phone: application.applicant.phone ?? "" },
            templateKey: "application.subAdminApproved",
            vars: {
              applicant_name: `${application.applicant.firstName} ${application.applicant.lastName}`,
              application_number: application.applicationNumber,
              service_name: application.service.name,
              application_id: application.id,
              reviewer_name: reviewerName,
              reviewed_at: new Date().toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" }),
            },
            channels: ["email", "sms"],
          });
        } else if (action === "request_correction") {
          await notify({
            userId: application.applicant.id,
            to: { email: application.applicant.email, phone: application.applicant.phone ?? "" },
            templateKey: "application.subAdminCorrectionRequested",
            vars: {
              applicant_name: `${application.applicant.firstName} ${application.applicant.lastName}`,
              application_number: application.applicationNumber,
              service_name: application.service.name,
              application_id: application.id,
              correction_note: comment || "Please upload a clear payment receipt or verify your transfer reference.",
              reviewer_name: reviewerName,
              reviewed_at: new Date().toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" }),
            },
            channels: ["email", "sms"],
          });
        } else if (action === "decline") {
          await notify({
            userId: application.applicant.id,
            to: { email: application.applicant.email, phone: application.applicant.phone ?? "" },
            templateKey: "application.subAdminDeclined",
            vars: {
              applicant_name: `${application.applicant.firstName} ${application.applicant.lastName}`,
              application_number: application.applicationNumber,
              service_name: application.service.name,
              application_id: application.id,
              decline_reason: comment || "Payment evidence could not be verified.",
              reviewer_name: reviewerName,
              reviewed_at: new Date().toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" }),
            },
            channels: ["email", "sms"],
          });
        }
      }
    } catch (notifyErr) {
      console.error("[subAdminReviewStaticAccountPayment] notify() failed, continuing:", notifyErr);
    }

    return sendSuccess(
      res,
      result,
      action === "approve"
        ? "Payment evidence approved by Sub-Admin and forwarded to Treasurer for final confirmation"
        : action === "decline"
        ? "Payment evidence declined by Sub-Admin"
        : "Correction requested on payment evidence"
    );
  } catch (err) {
    next(err);
  }
};


/**
 * GET /api/v1/treasurer/payments/:paymentId/gpay-audit
 * Retrieves live GPay Providus Bank transaction audit details, compares expected vs settled amount,
 * and detects underpayments, overpayments, or missing bank settlements.
 */
export const auditPaymentWithGPay = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let { paymentId } = req.params;
    if (Array.isArray(paymentId)) paymentId = paymentId[0];

    const payment = await prisma.payment.findUnique({
      where: { id: String(paymentId) },
      include: {
        invoice: {
          include: {
            application: {
              include: { applicant: true, service: true },
            },
          },
        },
      },
    });

    if (!payment) {
      return sendError(res, "Payment record not found", "NOT_FOUND", null, 404);
    }

    const invoice = payment.invoice;
    const application = invoice?.application;
    const expectedAmount = Number(invoice?.amount || payment.amount || 0);
    const claimedAmount = Number(payment.amount || 0);
    const ref = payment.gatewayRef || payment.reference;
    const destAccountNumber = invoice?.virtualAccountNumber;

    const GPAY_BASE = "https://gpay.gfa-tech.com/api/v1";
    const GPAY_TOKEN =
      process.env.GPAY_SECRET_KEY || "";

    let gpayData: any = null;

    // 1. Try single transaction lookup if ref is a GPAY ref
    if (ref && ref.startsWith("GPAY_")) {
      try {
        const resp = await fetch(`${GPAY_BASE}/transactions/${encodeURIComponent(ref)}`, {
          headers: {
            Authorization: `Bearer ${GPAY_TOKEN}`,
            Accept: "application/json",
          },
        });
        if (resp.ok) {
          const json: any = await resp.json();
          if (json?.data) {
            gpayData = json.data;
          }
        }
      } catch (e) {
        console.warn("[auditPaymentWithGPay] single tx fetch error:", e);
      }
    }

    // 2. If not found by direct ref, search recent transactions
    if (!gpayData) {
      try {
        const resp = await fetch(
          `${GPAY_BASE}/transactions?channel=all&status=all&page=1&limit=50`,
          {
            headers: {
              Authorization: `Bearer ${GPAY_TOKEN}`,
              Accept: "application/json",
            },
          },
        );
        if (resp.ok) {
          const json: any = await resp.json();
          const list = Array.isArray(json?.data?.data)
            ? json.data.data
            : Array.isArray(json?.data)
            ? json.data
            : [];

          const pFullName = (application?.applicant
            ? `${application.applicant.firstName} ${application.applicant.lastName}`
            : "").toLowerCase().trim();
          const pTokens = pFullName.split(/[\s,.-]+/).filter((tok: string) => tok.length >= 3);

          const match = list.find((t: any) => {
            if (ref && (t.gpay_reference === ref || t.merchant_transaction_ref === ref)) return true;
            if (destAccountNumber && String(t.account_number).trim() === String(destAccountNumber).trim()) {
              const cName = String(t.customer?.name || t.payer_details?.source_account_name || "").toLowerCase().trim();
              const cTokens = cName.split(/[\s,.-]+/).filter((tok: string) => tok.length >= 3);
              const hasSharedToken = pTokens.some((tok: string) => cTokens.includes(tok));
              if (hasSharedToken) return true;
              if (pFullName && cName && (pFullName.includes(cName) || cName.includes(pFullName))) return true;
              if (Math.abs(Number(t.settled_amount || t.amount) - expectedAmount) < 0.01) return true;
              // If there's only 1 transaction matching this specific dedicated virtual account
              const txsForAccount = list.filter((x: any) => String(x.account_number).trim() === String(destAccountNumber).trim());
              if (txsForAccount.length === 1) return true;
            }
            return false;
          });

          if (match) {
            const singleResp = await fetch(
              `${GPAY_BASE}/transactions/${encodeURIComponent(match.gpay_reference)}`,
              {
                headers: {
                  Authorization: `Bearer ${GPAY_TOKEN}`,
                  Accept: "application/json",
                },
              },
            );
            if (singleResp.ok) {
              const singleJson: any = await singleResp.json();
              gpayData = singleJson.data || match;
            } else {
              gpayData = match;
            }

            // Persist the matched gatewayRef in database if not yet set
            if (!payment.gatewayRef && gpayData?.gpay_reference) {
              await prisma.payment.update({
                where: { id: payment.id },
                data: { gatewayRef: gpayData.gpay_reference },
              }).catch((e: any) => console.warn("[auditPaymentWithGPay] error persisting gatewayRef:", e));
            }
          }
        }
      } catch (e) {
        console.warn("[auditPaymentWithGPay] list fetch error:", e);
      }
    }

    if (!gpayData) {
      return sendSuccess(res, {
        foundInGateway: false,
        expectedAmount,
        claimedAmount,
        settledAmount: 0,
        shortfall: expectedAmount,
        isUnderpayment: true,
        isExactMatch: false,
        isOverpayment: false,
        status: "unverified",
        message:
          "No matching Providus Bank settlement record found on the payment gateway yet. Awaiting bank inflow or confirmation.",
        paymentRecord: {
          id: payment.id,
          reference: payment.reference,
          gatewayRef: payment.gatewayRef,
          status: payment.status,
          matchStatus: payment.matchStatus,
          proofUrl: payment.proofUrl,
          destAccountNumber: invoice?.virtualAccountNumber || "Providus Dedicated VA",
          destBankName: invoice?.virtualBankName || "Providus Bank Plc",
        },
      });
    }

    const settledAmount = Number(
      gpayData.settled_amount ?? gpayData.amount ?? 0,
    );
    const difference = Number((settledAmount - expectedAmount).toFixed(2));
    const isUnderpayment = settledAmount < expectedAmount - 0.01;
    const isOverpayment = settledAmount > expectedAmount + 0.01;
    const isExactMatch = !isUnderpayment && !isOverpayment;
    const shortfall = isUnderpayment ? Math.abs(difference) : 0;

    const audit = {
      foundInGateway: true,
      expectedAmount,
      claimedAmount,
      settledAmount,
      difference,
      shortfall,
      isUnderpayment,
      isExactMatch,
      isOverpayment,
      status: gpayData.status,
      gatewayDetails: {
        gpayReference: gpayData.gpay_reference,
        merchantTransactionRef: gpayData.merchant_transaction_ref,
        accountNumber: gpayData.account_number,
        accountName: gpayData.account_name,
        serviceCode: gpayData.service_code,
        serviceName: gpayData.service_name,
        gatewayName: gpayData.gateway_name || "Providus",
        sessionId: gpayData.session_id,
        settlementId: gpayData.settlement_id || gpayData.settlement_record?.settlement_id,
        channel: gpayData.channel?.title || "Reserved Virtual Account",
        createdAt: gpayData.created_at,
        settledAt: gpayData.settlement_record?.settled_at || gpayData.updated_at,
      },
      payerDetails: {
        customerName: gpayData.customer?.name,
        sourceAccountName: gpayData.payer_details?.source_account_name,
        sourceAccountNumber: gpayData.payer_details?.source_account_number,
        sourceBankName: gpayData.payer_details?.source_bank_name,
        tranRemarks: gpayData.payer_details?.tran_remarks,
        tranDateTime: gpayData.payer_details?.tran_date_time,
      },
    };

    return sendSuccess(res, audit, "Live GPay payment audit retrieved successfully");
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/treasurer/gpay-transactions
 * List live multi-channel transactions from GPay monitoring hub
 * Enriches transactions with local database match data
 */
export const listGPayTransactions = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const {
      channel = "all",
      status = "all",
      page = "1",
      limit = "25",
      search = "",
      fromDate,
      toDate,
    } = req.query as Record<string, string>;

    const GPAY_BASE = "https://gpay.gfa-tech.com/api/v1";
    const GPAY_SECRET =
      process.env.GPAY_SECRET_KEY || "";

    const qParams = new URLSearchParams();
    if (channel) qParams.set("channel", channel);
    if (status) qParams.set("status", status);
    if (page) qParams.set("page", page);
    if (limit) qParams.set("limit", limit);
    if (search) qParams.set("search", search);
    if (fromDate) qParams.set("from_date", fromDate);
    if (toDate) qParams.set("to_date", toDate);

    const gpayUrl = `${GPAY_BASE}/transactions?${qParams.toString()}`;
    const gpayRes = await fetch(gpayUrl, {
      headers: {
        Authorization: `Bearer ${GPAY_SECRET}`,
        Accept: "application/json",
      },
    });

    if (!gpayRes.ok) {
      const errText = await gpayRes.text();
      return sendError(
        res,
        `GPay API returned status ${gpayRes.status}: ${errText.slice(0, 200)}`,
        "GATEWAY_ERROR",
        null,
        502,
      );
    }

    const gpayJson: any = await gpayRes.json();
    const transactions = gpayJson.data || [];

    // Extract all references and account numbers to look up in local database
    const gpayRefs = transactions.map((t: any) => t.gpay_reference).filter(Boolean);
    const merchantRefs = transactions.map((t: any) => t.merchant_transaction_ref).filter(Boolean);

    // Find existing payments linked in local DB
    const matchedPayments = await prisma.payment.findMany({
      where: {
        OR: [
          { gatewayRef: { in: gpayRefs } },
          { gatewayRef: { in: merchantRefs } },
        ],
      },
      include: {
        invoice: {
          include: {
            application: {
              include: {
                applicant: true,
                service: true,
              },
            },
            receipts: true,
          },
        },
      },
    });

    const paymentByRef = new Map<string, any>();
    for (const p of matchedPayments) {
      if (p.gatewayRef) paymentByRef.set(p.gatewayRef, p);
    }

    // Also get recent applications awaiting payment confirmation to allow quick matching suggestions
    const awaitingApps = await prisma.application.findMany({
      where: {
        status: { in: ["awaiting_payment_confirmation", "awaiting_form", "submitted"] },
      },
      include: {
        applicant: true,
        service: true,
        invoice: {
          include: {
            payments: true,
          },
        },
      },
      take: 50,
      orderBy: { createdAt: "desc" },
    });

    // Enrich transactions with local match info
    const enrichedTransactions = transactions.map((t: any) => {
      const matched = paymentByRef.get(t.gpay_reference) || paymentByRef.get(t.merchant_transaction_ref);

      let potentialMatch: any = null;
      if (!matched && t.customer?.name) {
        const cName = t.customer.name.toLowerCase();
        potentialMatch = awaitingApps.find((app: any) => {
          const aName = `${app.applicant?.firstName} ${app.applicant?.lastName}`.toLowerCase();
          const tokens = cName.split(/\s+/).filter((x: string) => x.length > 2);
          return tokens.some((tk: string) => aName.includes(tk));
        });
      }

      return {
        ...t,
        lgaMatch: matched
          ? {
              isMatched: true,
              paymentId: matched.id,
              paymentStatus: matched.status,
              matchStatus: matched.matchStatus,
              amountPaid: matched.amount,
              applicationId: matched.invoice?.application?.id,
              applicationNumber: matched.invoice?.application?.applicationNumber,
              serviceName: matched.invoice?.application?.service?.name,
              citizenName: matched.invoice?.application?.applicant
                ? `${matched.invoice.application.applicant.firstName} ${matched.invoice.application.applicant.lastName}`
                : undefined,
              receiptNumber: matched.invoice?.receipts?.[0]?.receiptNumber,
            }
          : potentialMatch
          ? {
              isMatched: false,
              isPotentialMatch: true,
              applicationId: potentialMatch.id,
              applicationNumber: potentialMatch.applicationNumber,
              serviceName: potentialMatch.service?.name,
              citizenName: `${potentialMatch.applicant?.firstName} ${potentialMatch.applicant?.lastName}`,
              expectedAmount: potentialMatch.invoice?.amount,
              paymentId: potentialMatch.invoice?.payments?.[0]?.id,
            }
          : {
              isMatched: false,
              isPotentialMatch: false,
            },
      };
    });

    return sendSuccess(
      res,
      {
        summary: gpayJson.summary || {},
        merchant: gpayJson.merchant || {},
        pagination: gpayJson.pagination || {},
        transactions: enrichedTransactions,
        awaitingApplications: awaitingApps.map((a: any) => ({
          id: a.id,
          applicationNumber: a.applicationNumber,
          serviceName: a.service?.name,
          citizenName: a.applicant ? `${a.applicant.firstName} ${a.applicant.lastName}` : "—",
          amount: a.invoice?.amount,
          status: a.status,
        })),
      },
      "GPay live transactions and settlements retrieved successfully",
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/treasurer/settle-gpay-transaction
 * Settle a live GPay bank transaction to an LGA application or revenue head
 */
export const settleGPayTransaction = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const officerId = req.user!.id;
    const {
      gpayReference,
      applicationId,
      applicationNumber,
      overrideUnderpayment = false,
      remarks,
    } = req.body || {};

    if (!gpayReference) {
      return sendError(res, "gpayReference is required", "BAD_REQUEST", null, 400);
    }

    const GPAY_BASE = "https://gpay.gfa-tech.com/api/v1";
    const GPAY_SECRET =
      process.env.GPAY_SECRET_KEY || "";

    // 1. Fetch exact transaction from GPay
    const gpayRes = await fetch(
      `${GPAY_BASE}/transactions/${encodeURIComponent(gpayReference)}`,
      {
        headers: {
          Authorization: `Bearer ${GPAY_SECRET}`,
          Accept: "application/json",
        },
      },
    );

    if (!gpayRes.ok) {
      return sendError(
        res,
        `Could not retrieve transaction ${gpayReference} from GPay`,
        "GATEWAY_ERROR",
        null,
        404,
      );
    }

    const gpayJson: any = await gpayRes.json();
    const tx = gpayJson.data || gpayJson;
    const settledAmount = Number(tx.settled_amount ?? tx.amount ?? 0);
    const isSuccess = tx.status === "success" || tx.status === "SUCCESS";

    if (!isSuccess && !overrideUnderpayment) {
      return sendError(
        res,
        `Cannot settle transaction with status "${tx.status}". Settlement requires a successful bank transfer.`,
        "UNSETTLED_TRANSACTION",
        { status: tx.status },
        400,
      );
    }

    // 2. Find target Application
    let application: any = null;
    if (applicationId) {
      application = await prisma.application.findUnique({
        where: { id: applicationId },
        include: {
          applicant: true,
          service: true,
          invoice: {
            include: {
              payments: true,
              receipts: true,
            },
          },
        },
      });
    } else if (applicationNumber) {
      application = await prisma.application.findUnique({
        where: { applicationNumber },
        include: {
          applicant: true,
          service: true,
          invoice: {
            include: {
              payments: true,
              receipts: true,
            },
          },
        },
      });
    } else {
      // Search by gatewayRef
      const payment = await prisma.payment.findFirst({
        where: {
          OR: [
            { gatewayRef: gpayReference },
            { gatewayRef: tx.merchant_transaction_ref },
          ],
        },
        include: {
          invoice: {
            include: {
              application: {
                include: { applicant: true, service: true },
              },
              receipts: true,
              payments: true,
            },
          },
        },
      });
      if (payment?.invoice?.application) {
        application = payment.invoice.application;
        application.invoice = payment.invoice;
      }
    }

    if (!application) {
      return sendError(
        res,
        `No application found to link this transaction. Please provide an Application Number (e.g. APP-2026-XXXXXX).`,
        "APPLICATION_NOT_FOUND",
        null,
        404,
      );
    }

    const invoice = application.invoice;
    if (!invoice) {
      return sendError(
        res,
        "Application does not have an active invoice",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const expectedFee = Number(invoice.amount || 0);
    if (expectedFee > 0 && settledAmount < expectedFee - 0.01 && !overrideUnderpayment) {
      const shortfall = expectedFee - settledAmount;
      return sendError(
        res,
        `Underpayment detected: Bank settled amount (₦${settledAmount.toLocaleString()}) is less than statutory fee (₦${expectedFee.toLocaleString()}). Shortfall is ₦${shortfall.toLocaleString()}. Check "Override Underpayment" to proceed if authorized.`,
        "UNDERPAYMENT_DETECTED",
        { expectedFee, settledAmount, shortfall },
        400,
      );
    }

    // 3. Execute settlement transaction in Prisma
    const targetPayment = invoice.payments?.[0];

    const result = await prisma.$transaction(async (txPrisma) => {
      let paymentRecord: any;
      if (targetPayment) {
        paymentRecord = await txPrisma.payment.update({
          where: { id: targetPayment.id },
          data: {
            status: "confirmed",
            amount: settledAmount,
            gatewayRef: gpayReference,
            confirmedById: officerId,
            confirmedAt: new Date(),
            matchStatus: "matched",
          },
        });
      } else {
        paymentRecord = await txPrisma.payment.create({
          data: {
            reference: generateReceiptNumber("PAY"),
            invoiceId: invoice.id,
            amount: settledAmount,
            method: "bank_transfer",
            gatewayRef: gpayReference,
            status: "confirmed",
            confirmedById: officerId,
            confirmedAt: new Date(),
            matchStatus: "matched",
          },
        });
      }

      const updatedInvoice = await txPrisma.invoice.update({
        where: { id: invoice.id },
        data: {
          paymentStatus: "confirmed",
          paidAt: new Date(),
        },
      });

      const existingReceipt = await txPrisma.receipt.findUnique({
        where: { invoiceId: invoice.id },
      });

      const receipt =
        existingReceipt ??
        (await txPrisma.receipt.create({
          data: {
            receiptNumber: generateReceiptNumber("RCP"),
            verificationCode: generateVerificationCode(),
            qrToken: generateQrToken(),
            amountPaid: settledAmount,
            invoiceId: invoice.id,
            issuedById: officerId,
          },
        }));

      // Release application status
      const updatedApplication = await txPrisma.application.update({
        where: { id: application.id },
        data: {
          status: (() => {
            const fd =
              application.formData && typeof application.formData === "object"
                ? (application.formData as Record<string, any>)
                : {};
            const metaKeys = new Set([
              "_publicTransferNotice",
              "subAdminPaymentReview",
              "subAdminReview",
              "applicantResubmission",
              "termsAccepted",
              "termsAcceptedAt",
              "fullName",
              "email",
              "phone",
            ]);
            const hasServiceFields =
              !fd._publicTransferNotice &&
              Object.keys(fd).some(
                (k: string) =>
                  !metaKeys.has(k) &&
                  fd[k] !== undefined &&
                  fd[k] !== null &&
                  fd[k] !== "",
              );
            return hasServiceFields ? "submitted" : "awaiting_form";
          })(),
        },
      });

      return { paymentRecord, updatedInvoice, receipt, updatedApplication };
    });

    // 4. Audit Log
    await prisma.auditLog.create({
      data: {
        action: "payment_confirmed",
        entity: "Payment",
        entityId: result.paymentRecord.id,
        userId: officerId,
        details: {
          flow: "gpay_hub_settlement",
          gpayReference,
          settledAmount,
          applicationNumber: application.applicationNumber,
          sessionId: tx.session_id,
          settlementId: tx.settlement_id,
          remarks,
        },
        ipAddress: getIp(req),
      },
    });

    // 5. Notification
    try {
      if (application.applicant) {
        await notify({
          userId: application.applicant.id,
          to: {
            email: application.applicant.email,
            phone: application.applicant.phone ?? "",
          },
          templateKey: "application.completeApplication",
          vars: {
            applicant_name: `${application.applicant.firstName} ${application.applicant.lastName}`,
            application_number: application.applicationNumber,
            service_name: application.service?.name || "Statutory Service",
            application_id: application.id,
          },
          channels: ["email", "sms"],
        });
      }
    } catch (notifyErr) {
      console.error("[settleGPayTransaction] notify() error:", notifyErr);
    }

    return sendSuccess(
      res,
      result,
      `Transaction ${gpayReference} (₦${settledAmount.toLocaleString()}) successfully settled and linked to Application ${application.applicationNumber}`,
    );
  } catch (err) {
    next(err);
  }
};
