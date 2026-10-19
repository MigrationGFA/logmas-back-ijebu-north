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

    const { amount, status } = parsed.data;
    const statusEnum = status ? "ACTIVE" : "INACTIVE";

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

    if (payment.method !== "bank_transfer" || !payment.proofUrl) {
      return sendError(res, "Upload payment proof before confirmation", "BAD_REQUEST", null, 400);
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
        data: { status: "submitted" },
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
