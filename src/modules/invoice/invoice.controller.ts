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
    } 
    else if(tab === "confirmed"){
       where.paymentStatus = {
        in: ["confirmed"],
      };
    }
    else {
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

    // Additional check: For business_owner and citizen, verify they own the invoice
    // This is redundant with the where clause but added for extra security
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

    // Return sanitized response with only necessary fields

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

    // Cash/POS only — online payments go through /pay-online now, not this route.
    if (!["field_officer", "lga_admin", "super_admin"].includes(role)) {
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
// Citizen (or staff on their behalf) uploads evidence of a manual bank
// transfer for a PENDING invoice. Records the proof on the invoice's pending
// `bank_transfer` Payment — the same row whose `reference` the reserved-
// account tab displays (pendingTransferReference) — and parks the linked
// application at `awaiting_payment_confirmation` so the treasurer's Payment
// Confirmations worklist picks it up (same mechanism the field-officer flow
// uses). NEVER confirms the payment; that stays the treasurer's call.
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
    if (!file) {
      return sendError(res, "A proof file is required", "VALIDATION_ERROR", null, 400);
    }

    // Same access rules as getInvoiceById: privileged roles view any invoice,
    // citizens/business owners only their own.
    const privilegedRoles: Role[] = [
      "super_admin",
      "lga_admin",
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
        application: { select: { id: true, status: true } },
        service: { select: { code: true, name: true } },
        payments: {
          orderBy: { createdAt: "desc" },
          select: { id: true, amount: true, status: true, method: true },
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
    const normalizedRelativePath = file.path.replace(/\\/g, "/");
    const proofUrl = `${serverUrl}/${normalizedRelativePath}`;

    // Attach to the pending bank_transfer Payment the citizen was shown.
    // Reuse the newest one (the VA endpoint refreshes it inside its reuse
    // window); only mint a row if the reserved-account tab was never opened.
    let payment: { id: string } | undefined = invoice.payments.find(
      (p) => p.status === "pending" && p.method === "bank_transfer",
    );

    if (!payment) {
      const paidAmount = invoice.payments
        .filter((p) => p.status === "confirmed")
        .reduce((sum, p) => sum + Number(p.amount), 0);
      const balanceDue = Math.max(Number(invoice.amount) - paidAmount, 0);
      payment = await prisma.payment.create({
        data: {
          reference: generateReference(),
          amount: balanceDue,
          method: "bank_transfer",
          status: "pending",
          serviceCode: invoice.service.code,
          narration: `Citizen proof upload — ${invoice.service.name}`,
          invoice: { connect: { id: invoice.id } },
        },
        select: { id: true },
      });
    }

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        proofUrl,
        proofUploadedById: uploaderId,
        proofUploadedAt: new Date(),
      },
    });

    // Surface it to the treasurer: the Payment Confirmations worklist only
    // lists applications parked at awaiting_payment_confirmation. Park from
    // the pre-payment states only — never yank an application out of an
    // in-progress review.
    let parkedForConfirmation = false;
    if (invoice.application) {
      if (invoice.application.status === "awaiting_payment_confirmation") {
        parkedForConfirmation = true;
      } else if (["submitted", "payment_pending"].includes(invoice.application.status)) {
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
          event: "proof_uploaded",
          invoiceNumber: invoice.invoiceNumber,
          applicationId: invoice.application?.id ?? null,
          parkedForConfirmation,
          proofUrl,
        },
        ipAddress: getIp(req),
      },
    });

    return sendSuccess(
      res,
      { payment: updated, proofUrl, parkedForConfirmation },
      "Proof of payment uploaded",
    );
  } catch (err) {
    next(err);
  }
};

