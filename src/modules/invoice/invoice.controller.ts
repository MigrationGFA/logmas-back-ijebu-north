import { InvoiceStatus, Role, Prisma, PaymentMethod } from "@prisma/client";
import { Request, Response, NextFunction } from "express";
import { prisma } from "../../utils/prisma";
import { sendError, sendSuccess } from "../../utils/response";
import {
  generateQrToken,
  generateReceiptNumber,
  generateReference,
  generateVerificationCode,
} from "../../utils/generators";
import { getIp } from "../complaints/complaints.controller";
import { confirmPayment } from "../payment/payment.service";
import { sameAmount, serviceCodesForGpay, SERVICE_CODE_BY_SERVICE } from "../payment/gpay.service";

interface GetInvoicesQuery {
  role: Role;
  userId: string;
  tab?: string;
  search?: string;
}

export const fetchInvoicesHubData = async ({
  role,
  userId,
  tab,
  search,
}: GetInvoicesQuery) => {
  const where: Prisma.InvoiceWhereInput = {};

  // ---------------------------------------------------------
  // Access control
  // ---------------------------------------------------------
  if (role === Role.citizen || role === Role.business_owner) {
    where.application = {
      applicantId: userId,
    };
  } else if (role === Role.field_officer) {
    where.createdById = userId;
  }

  // ---------------------------------------------------------
  // Search
  // ---------------------------------------------------------
  if (search?.trim()) {
    const value = search.trim();

    where.OR = [
      {
        invoiceNumber: {
          contains: value,
          mode: "insensitive",
        },
      },
      {
        application: {
          applicationNumber: {
            contains: value,
            mode: "insensitive",
          },
        },
      },
      {
        application: {
          service: {
            name: {
              contains: value,
              mode: "insensitive",
            },
          },
        },
      },
    ];
  }

  // ---------------------------------------------------------
  // Payment status filter
  // ---------------------------------------------------------
  if (tab && tab !== "all") {
    if (tab === "pending") {
      where.paymentStatus = {
        in: ["pending"],
      };
    } else if (tab === "confirmed") {
      where.paymentStatus = {
        in: ["confirmed"],
      };
    } else {
      where.paymentStatus = "failed";
    }
  }

  // ---------------------------------------------------------
  // Fetch invoices
  // ---------------------------------------------------------
  const invoices = await prisma.invoice.findMany({
    where,
    include: {
      application: {
        select: {
          id: true,
          applicationNumber: true,
          applicantId: true,
          createdAt: true,
          formData: true,
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
          status: true,
          confirmedAt: true,
        },
      },

      receipts: {
        select: {
          id: true,
          receiptNumber: true,
        },
      },
    },

    orderBy: {
      createdAt: "desc",
    },
  });

  // ---------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------
  const totalCollected = invoices.reduce((sum, invoice) => {
    const paid = invoice.payments
      .filter((payment) => payment.status === "confirmed")
      .reduce((paymentSum, payment) => paymentSum + Number(payment.amount), 0);

    return sum + paid;
  }, 0);

  const outstanding = invoices.reduce((sum, invoice) => {
    const paid = invoice.payments
      .filter((payment) => payment.status === "confirmed")
      .reduce((paymentSum, payment) => paymentSum + Number(payment.amount), 0);

    return sum + Math.max(Number(invoice.amount) - paid, 0);
  }, 0);

  const transactions = invoices.reduce(
    (count, invoice) => count + invoice.receipts.length,
    0,
  );

  const avgPayment =
    transactions > 0 ? Math.round(totalCollected / transactions) : 0;

  // ---------------------------------------------------------
  // Return
  // ---------------------------------------------------------
  return {
    stats: {
      outstanding,
      totalCollected,
      transactions,
      avgPayment,
    },

    invoices: invoices.map((invoice) => {
      const formData =
        invoice.application?.formData &&
        typeof invoice.application.formData === "object"
          ? (invoice.application.formData as Record<string, any>)
          : {};

      const customerName =
        formData.fullName ||
        formData.applicantName ||
        formData.ownerName ||
        formData.businessName ||
        formData.companyName ||
        null;

      const confirmedPayments = invoice.payments
        .filter((payment) => payment.status === "confirmed")
        .sort(
          (a, b) =>
            (b.confirmedAt?.getTime() ?? 0) - (a.confirmedAt?.getTime() ?? 0),
        );

      return {
        id: invoice.id,
        reference: invoice.invoiceNumber,
        amount: Number(invoice.amount),
        paymentStatus: invoice.paymentStatus,
        customerName,
        paidAt: invoice.paidAt ?? confirmedPayments[0]?.confirmedAt ?? null,
        createdAt: invoice.createdAt,
        dateOfApplication: invoice.application?.createdAt ?? null,

        application: invoice.application
          ? {
              id: invoice.application.id,
              applicationNumber: invoice.application.applicationNumber,
              applicantId: invoice.application.applicantId,
            }
          : null,

        service: invoice.application?.service
          ? {
              id: invoice.application.service.id,
              code: invoice.application.service.code,
              name: invoice.application.service.name,
              category: invoice.application.service.category,
            }
          : null,

        receipts: invoice.receipts,
      };
    }),
  };
};

/**
 * @desc    Get Invoices Ledger List and Stats Overview in a single batch query
 * @route   GET /api/v1/invoices/hub
 * @access  Authenticated
 */
export const getInvoicesHubOverview = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { id: userId, role } = (req as any).user as {
      id: string;
      role: Role;
    };
    const { tab, search } = req.query as { tab?: string; search?: string };

    const payload = await fetchInvoicesHubData({
      role,
      userId,
      tab,
      search,
    });

    res.status(200).json({
      success: true,
      ...payload,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/invoices/:id
export const getInvoiceById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user!;

    // Define roles that can view any invoice
    const privilegedRoles: Role[] = [
      "super_admin",
      "lga_admin",
      "sub_admin" as Role,
      "chairman",
      "treasurer",
      "auditor",
      "ward_councillor",
      "field_officer",
    ];

    const isPrivileged = privilegedRoles.includes(role);

    // Build where clause based on role
    const whereClause: any = {
      invoiceNumber: String(id),
    };

    // If not privileged, restrict to own invoices
    if (!isPrivileged) {
      whereClause.OR = [
        {
          application: {
            applicantId: userId,
          },
        },
        {
          createdById: userId,
        },
        {
          assignedOfficerId: userId,
        },
        {
          payments: {
            some: {
              paidById: userId,
            },
          },
        },
      ];
    }

    const invoice = await prisma.invoice.findFirst({
      where: whereClause,
      include: {
        application: {
          select: {
            id: true,
            applicationNumber: true,
            applicantId: true,
            status: true,
            formData: true,
            service: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
        payments: {
          orderBy: {
            createdAt: "desc",
          },
          select: {
            id: true,
            amount: true,
            method: true,
            status: true,
            matchStatus: true,
            payerName: true,
            reference: true,
            gatewayRef: true,
            narration: true,
            confirmedAt: true,
            createdAt: true,
            paidById: true,
            proofUrl: true,
            proofUploadedById: true,
            proofUploadedAt: true,
          },
        },
        receipts: {
          orderBy: {
            issuedAt: "desc",
          },
          select: {
            id: true,
            receiptNumber: true,
            verificationCode: true,
            qrToken: true,
            amountPaid: true,
            pdfUrl: true,
            issuedAt: true,
            issuedById: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
        service: {
          select: {
            id: true,
            code: true,
            name: true,
            description: true,
          },
        },
      },
    });

    if (!invoice) {
      return sendError(
        res,
        "Invoice not found or you don't have permission to view it",
        "NOT_FOUND",
        null,
        404,
      );
    }

    if (!isPrivileged && (role === "business_owner" || role === "citizen")) {
      const isOwner =
        invoice.application?.applicantId === userId ||
        invoice.createdById === userId ||
        invoice.assignedOfficerId === userId ||
        invoice.payments.some((payment) => payment.paidById === userId);

      if (!isOwner) {
        return sendError(
          res,
          "You don't have permission to view this invoice",
          "FORBIDDEN",
          null,
          403,
        );
      }
    }

    return sendSuccess(res, invoice);
  } catch (err) {
    next(err);
  }
};

// POST /api/v1/invoices/:id/pay
export const recordInvoicePayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const role = req.user!.role;
    const { method, amount, reference, narration } = req.body;

    const invoice = await prisma.invoice.findUnique({
      where: { invoiceNumber: String(id) },
    });
    if (!invoice)
      return sendError(res, "Invoice not found", "NOT_FOUND", null, 404);

    if (["paid", "cancelled"].includes(invoice.paymentStatus)) {
      return sendError(
        res,
        "Invoice is already paid or cancelled",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    if (!["field_officer", "lga_admin", "super_admin", "sub_admin"].includes(role)) {
      return sendError(
        res,
        "Only field officers can record cash or POS payments",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const paymentAmount = Number(amount);

    const result = await confirmPayment({
      invoiceId: invoice.id,
      amount: paymentAmount,
      method,
      reference,
      narration,
      paidById: invoice.createdById,
      confirmedById: userId,
    });

    await prisma.auditLog.create({
      data: {
        action: "payment_confirmed",
        entity: "Payment",
        entityId: result.payment.id,
        user: { connect: { id: userId } },
        details: {
          invoiceId: id,
          amount: paymentAmount,
          method,
          isFullPayment: result.isFullPayment,
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
        isFullPayment: result.isFullPayment,
        message: result.isFullPayment
          ? "Payment confirmed. Receipt generated."
          : `Partial payment recorded. Balance due: ₦${Number(result.invoice.balanceDue)}`,
      },
      result.isFullPayment ? "Payment complete" : "Partial payment recorded",
    );
  } catch (err) {
    next(err);
  }
};

// POST /api/v1/invoices/:invoiceNumber/payment-proof
//
// Channel 1 ("I Have Paid" + Optional Proof Upload):
// Citizen (or staff on their behalf) notifies the system that a bank transfer
// to the Dedicated Providus Static Virtual Account has been completed, with
// an optional proof of payment file.
// 1. Places the application & payment into "Payment Verification in Progress"
//    (awaiting_payment_confirmation / matchStatus: "awaiting_verification").
// 2. Checks if a matching Providus webhook settlement already arrived for
//    this Service Account + Exact Amount — if so, confirms immediately and
//    issues the Official Receipt without waiting for the Treasurer!
export const uploadInvoicePaymentProof = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const uploaderId = req.user!.id;
    const { role } = req.user!;
    const invoiceNumber = String(
      Array.isArray(req.params.invoiceNumber)
        ? req.params.invoiceNumber[0]
        : req.params.invoiceNumber,
    );

    const file = (req as any).file as
      | { originalname?: string; path: string }
      | undefined;

    const privilegedRoles: Role[] = [
      "super_admin",
      "lga_admin",
      "sub_admin" as Role,
      "chairman",
      "treasurer",
      "auditor",
      "ward_councillor",
      "field_officer",
    ];
    const isPrivileged = privilegedRoles.includes(role);

    const whereClause: any = { invoiceNumber };
    if (!isPrivileged) {
      whereClause.OR = [
        { application: { applicantId: uploaderId } },
        { createdById: uploaderId },
        { assignedOfficerId: uploaderId },
        { payments: { some: { paidById: uploaderId } } },
      ];
    }

    const invoice = await prisma.invoice.findFirst({
      where: whereClause,
      include: {
        application: {
          include: {
            applicant: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
          },
        },
        service: { select: { code: true, name: true } },
        payments: {
          orderBy: { createdAt: "desc" },
          select: { id: true, reference: true, amount: true, status: true, method: true, proofUrl: true },
        },
      },
    });

    if (!invoice) {
      return sendError(
        res,
        "Invoice not found or you don't have permission to view it",
        "NOT_FOUND",
        null,
        404,
      );
    }

    if (invoice.paymentStatus !== "pending") {
      return sendError(res, "Invoice is not awaiting payment", "BAD_REQUEST", null, 400);
    }

    const serverUrl = `${req.protocol}://${req.get("host")}`;
    const normalizedRelativePath = file ? file.path.replace(/\\/g, "/") : "";
    const proofUrl = file ? `${serverUrl}/${normalizedRelativePath}` : undefined;

    const paidAmount = invoice.payments
      .filter((p) => p.status === "confirmed")
      .reduce((sum, p) => sum + Number(p.amount), 0);
    const balanceDue = Math.max(Number(invoice.amount) - paidAmount, 0);

    const applicantFullName = invoice.application?.applicant
      ? `${invoice.application.applicant.firstName} ${invoice.application.applicant.lastName}`.trim()
      : undefined;

    let payment: { id: string; reference: string } | undefined = invoice.payments.find(
      (p) => p.status === "pending" && p.method === "bank_transfer",
    );

    if (!payment) {
      payment = await prisma.payment.create({
        data: {
          reference: generateReference(),
          amount: balanceDue,
          method: "bank_transfer",
          status: "pending",
          matchStatus: "awaiting_verification",
          serviceCode: invoice.service.code,
          payerName: applicantFullName || null,
          narration: `Bank transfer marked paid — ${invoice.service.name}`,
          invoice: { connect: { id: invoice.id } },
        },
        select: { id: true, reference: true },
      });
    }

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        ...(proofUrl ? { proofUrl } : {}),
        proofUploadedById: uploaderId,
        proofUploadedAt: new Date(),
        matchStatus: "awaiting_verification",
        payerName: applicantFullName || undefined,
      },
    });

    // Check if an unmatched Reserved VA webhook settlement already arrived for this service + amount
    const gpayCode = SERVICE_CODE_BY_SERVICE[invoice.service.code];
    const matchingCodes = gpayCode ? serviceCodesForGpay(gpayCode) : [invoice.service.code];
    const unmatchedCredits = await prisma.payment.findMany({
      where: {
        status: "pending",
        method: "virtual_account",
        matchStatus: "unmatched",
        invoiceId: null,
        serviceCode: { in: matchingCodes },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
    });

    const exactAmountCredits = unmatchedCredits.filter((c) => sameAmount(c.amount, balanceDue));
    if (exactAmountCredits.length === 1) {
      const credit = exactAmountCredits[0];
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          gatewayRef: credit.gatewayRef,
          payerName: credit.payerName || applicantFullName || null,
          payerAccount: credit.payerAccount,
          payerBank: credit.payerBank,
          settledAt: credit.settledAt,
          rawPayload: credit.rawPayload ?? undefined,
          matchStatus: "matched",
        },
      });
      await prisma.payment.delete({ where: { id: credit.id } }).catch(() => {});

      const confirmRes = await confirmPayment({
        invoiceId: invoice.id,
        amount: balanceDue,
        method: "bank_transfer",
        reference: payment.reference,
        gatewayRef: credit.gatewayRef || undefined,
        narration: `Providus Bank VA settlement (${invoice.service.code})`,
        paidById: uploaderId,
      });

      return sendSuccess(
        res,
        {
          status: "confirmed",
          payment: confirmRes.payment,
          receipt: confirmRes.receipt,
          proofUrl: updated.proofUrl ?? null,
          parkedForConfirmation: false,
        },
        "Payment verified and confirmed! Official Receipt generated.",
      );
    }

    let parkedForConfirmation = false;
    if (invoice.application) {
      if (invoice.application.status === "awaiting_payment_confirmation") {
        parkedForConfirmation = true;
      } else if (["submitted", "payment_pending", "awaiting_form"].includes(invoice.application.status)) {
        await prisma.application.update({
          where: { id: invoice.application.id },
          data: { status: "awaiting_payment_confirmation" },
        });
        parkedForConfirmation = true;
      }
    }

    await prisma.auditLog.create({
      data: {
        action: "payment_confirmed",
        entity: "Payment",
        entityId: payment.id,
        userId: uploaderId,
        details: {
          event: proofUrl ? "proof_uploaded" : "transfer_marked_paid",
          invoiceNumber: invoice.invoiceNumber,
          applicationId: invoice.application?.id ?? null,
          parkedForConfirmation,
          proofUrl: updated.proofUrl ?? null,
        },
        ipAddress: getIp(req),
      },
    });

    return sendSuccess(
      res,
      {
        status: "awaiting_payment_confirmation",
        payment: updated,
        proofUrl: updated.proofUrl ?? null,
        parkedForConfirmation,
      },
      proofUrl
        ? "Payment Verification in Progress — proof uploaded"
        : "Payment Verification in Progress — transfer notification recorded",
    );
  } catch (err) {
    next(err);
  }
};
