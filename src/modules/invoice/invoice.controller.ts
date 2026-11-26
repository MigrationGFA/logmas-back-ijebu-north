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
import { normalizeNgPhone } from "../services/foCollection.controller";
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
                foOnly: true,
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
            foOnly: true,
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

// POST /api/v1/invoices/:invoiceNumber/fo-payment
//
// FO-only services: the payer transfers to the LGA collection account
// and the officer records it here with the payer's receipt attached as
// proof. Unlike recordInvoicePayment this does NOT confirm anything: it
// parks the payment as a pending claim and the application at
// `awaiting_payment_confirmation`, so the treasurer's confirmation
// remains the moment the collection becomes official (and the moment
// the initiating officer is notified).
//
// Method switching: a collection may have started as pay online, leaving
// a pending card payment behind when the payer opened the link. That is
// not a claim and must not block the officer: recording the transfer
// removes the abandoned card payment in the same transaction, retiring
// its reference so the old link can never settle the invoice.
export const recordFoInvoicePayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const role = req.user!.role;
    const { method } = req.body || {};

    // FO collections are transfer only (cash was removed Nov 23, 2026):
    // the payer transfers to the LGA collection account and the officer
    // records it here with the payer's proof attached.
    if (method !== "bank_transfer") {
      return sendError(
        res,
        "FO-only service payments are by bank transfer only",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }

    const file = (req as any).file as
      | { originalname?: string; path: string }
      | undefined;
    if (!file) {
      return sendError(
        res,
        "Payment proof is required: upload the payer's transfer receipt",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }
    const serverUrl = `${req.protocol}://${req.get("host")}`;
    const proofUrl = `${serverUrl}/${file.path.replace(/\\/g, "/")}`;

    if (!["field_officer", "sub_admin", "lga_admin", "super_admin"].includes(role)) {
      return sendError(
        res,
        "Only field officers can record FO-only service payments",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const invoice = await prisma.invoice.findUnique({
      where: { invoiceNumber: String(id) },
      include: { service: true, application: true },
    });
    if (!invoice)
      return sendError(res, "Invoice not found", "NOT_FOUND", null, 404);

    if (!invoice.service.foOnly) {
      return sendError(
        res,
        "This endpoint is only for FO-only service invoices",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    // The officer who recorded the collection is the one who states how
    // it was paid; admins may act on their behalf.
    if (role === "field_officer" && invoice.createdById !== userId) {
      return sendError(
        res,
        "Only the officer who recorded this collection can state how it was paid",
        "FORBIDDEN",
        null,
        403,
      );
    }

    if (invoice.paymentStatus !== "pending") {
      return sendError(
        res,
        "Invoice is not awaiting a payment record",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    // Only an active transfer claim blocks a new record. A pending card
    // payment (the payer opened the pay-online link, then the method was
    // switched to transfer) is not a claim; it is removed in the
    // transaction below instead of blocking the officer. A claim the
    // treasurer already rejected is not active either: the officer is
    // recording again precisely because it was bounced back.
    const existingClaim = await prisma.payment.findFirst({
      where: {
        invoiceId: invoice.id,
        status: "pending",
        method: "bank_transfer",
        NOT: { matchStatus: "rejected" },
      },
      select: { id: true },
    });
    if (existingClaim) {
      return sendError(
        res,
        "A payment is already recorded for this invoice and awaiting treasurer confirmation",
        "CONFLICT",
        null,
        409,
      );
    }

    const payment = await prisma.$transaction(async (tx) => {
      // The method switch is complete once a transfer is recorded: any
      // pending card payment on this invoice is abandoned, and deleting
      // it retires its reference, so the old pay link and its webhook
      // can never settle this invoice afterwards.
      await tx.payment.deleteMany({
        where: {
          invoiceId: invoice.id,
          status: "pending",
          method: "online_gateway",
        },
      });

      const created = await tx.payment.create({
        data: {
          reference: generateReference("PAY"),
          amount: invoice.amount,
          method: method as PaymentMethod,
          status: "pending",
          paidById: invoice.createdById,
          invoiceId: invoice.id,
          serviceCode: invoice.service.code,
          matchStatus: "awaiting_verification",
          proofUrl,
          proofUploadedById: userId,
          proofUploadedAt: new Date(),
        },
      });

      if (invoice.applicationId) {
        await tx.application.update({
          where: { id: invoice.applicationId },
          data: { status: "awaiting_payment_confirmation", declineReason: null },
        });
      }

      return created;
    });

    return sendSuccess(
      res,
      { payment },
      "Transfer recorded with proof. Awaiting treasurer confirmation.",
    );
  } catch (err) {
    next(err);
  }
};

// PATCH /api/v1/invoices/:invoiceNumber/fo-payment/proof
//
// The collecting officer attached the wrong receipt: while the recorded
// transfer still awaits treasurer confirmation, the officer can swap
// the proof on the same claim. The claim itself does not change, the
// treasurer only ever sees the current proof, and the swap restamps who
// uploaded it and when. Once the claim is confirmed or rejected, the
// proof is locked.
export const replaceFoInvoicePaymentProof = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const role = req.user!.role;

    const file = (req as any).file as
      | { originalname?: string; path: string }
      | undefined;
    if (!file) {
      return sendError(
        res,
        "Payment proof is required: upload the payer's transfer receipt",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }

    if (!["field_officer", "sub_admin", "lga_admin", "super_admin"].includes(role)) {
      return sendError(
        res,
        "Only field officers can replace FO collection proof",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const invoice = await prisma.invoice.findUnique({
      where: { invoiceNumber: String(id) },
      include: { service: true },
    });
    if (!invoice)
      return sendError(res, "Invoice not found", "NOT_FOUND", null, 404);

    if (!invoice.service.foOnly) {
      return sendError(
        res,
        "This endpoint is only for FO-only service invoices",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    if (role === "field_officer" && invoice.createdById !== userId) {
      return sendError(
        res,
        "Only the officer who recorded this collection can replace its receipt",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const claim = await prisma.payment.findFirst({
      where: {
        invoiceId: invoice.id,
        status: "pending",
        method: "bank_transfer",
        NOT: { matchStatus: "rejected" },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!claim) {
      return sendError(
        res,
        "There is no recorded transfer awaiting confirmation on this invoice",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const serverUrl = `${req.protocol}://${req.get("host")}`;
    const proofUrl = `${serverUrl}/${file.path.replace(/\\/g, "/")}`;

    const payment = await prisma.payment.update({
      where: { id: claim.id },
      data: {
        proofUrl,
        proofUploadedById: userId,
        proofUploadedAt: new Date(),
      },
    });

    return sendSuccess(
      res,
      { payment },
      "Receipt replaced. Awaiting treasurer confirmation.",
    );
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/v1/invoices/:invoiceNumber/fo-correction
 * The collecting officer answers a treasurer correction request on an
 * FO collection: the payer's details (name, phone, business, location)
 * and optionally a fresh receipt can be fixed, and the claim goes back
 * to the treasurer as a normal pending claim. The amount is never read
 * from the request, so it cannot change here. Outside a correction the
 * officer's only edit is replacing the receipt (fo-payment/proof).
 */
export const submitFoCorrection = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const role = req.user!.role;

    if (!["field_officer", "lga_admin", "super_admin"].includes(role)) {
      return sendError(
        res,
        "Only field officers can answer a correction on an FO collection",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const invoice = await prisma.invoice.findUnique({
      where: { invoiceNumber: String(id) },
      include: { service: true, application: true },
    });
    if (!invoice)
      return sendError(res, "Invoice not found", "NOT_FOUND", null, 404);

    if (!invoice.service.foOnly) {
      return sendError(
        res,
        "This endpoint is only for FO-only service invoices",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    if (role === "field_officer" && invoice.createdById !== userId) {
      return sendError(
        res,
        "Only the officer who recorded this collection can answer its correction",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const application = invoice.application;
    if (!application) {
      return sendError(
        res,
        "This invoice has no application record",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const claim = await prisma.payment.findFirst({
      where: {
        invoiceId: invoice.id,
        status: "pending",
        method: "bank_transfer",
        matchStatus: "correction_requested",
      },
      orderBy: { createdAt: "desc" },
    });
    if (!claim) {
      return sendError(
        res,
        "No correction is outstanding on this invoice",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    // Only payer details may change. Amount fields in the body are
    // ignored entirely: the collected amount is part of the record.
    const body = (req.body || {}) as Record<string, unknown>;
    const provided = (key: string) =>
      typeof body[key] === "string" ? (body[key] as string).trim() : undefined;

    const payerName = provided("payerName");
    if (payerName !== undefined && !payerName) {
      return sendError(
        res,
        "The payer name cannot be empty",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }
    const phone = provided("phone");
    if (phone !== undefined && !normalizeNgPhone(phone)) {
      return sendError(
        res,
        "Enter a valid Nigerian phone number for the payer",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }
    const merchantName = provided("merchantName");
    const location = provided("location");

    const existingFormData =
      application.formData && typeof application.formData === "object"
        ? (application.formData as Record<string, any>)
        : {};
    const updatedFormData: Record<string, any> = { ...existingFormData };
    if (payerName !== undefined) updatedFormData.payerName = payerName;
    if (phone !== undefined) updatedFormData.phone = phone;
    if (merchantName !== undefined) updatedFormData.merchantName = merchantName;
    if (location !== undefined) updatedFormData.location = location;
    if (existingFormData.treasurerCorrection) {
      updatedFormData.treasurerCorrection = {
        ...existingFormData.treasurerCorrection,
        resolvedAt: new Date().toISOString(),
        resolvedById: userId,
      };
    }

    const file = (req as any).file as
      | { originalname?: string; path: string }
      | undefined;
    const serverUrl = `${req.protocol}://${req.get("host")}`;
    const proofUrl = file
      ? `${serverUrl}/${file.path.replace(/\\/g, "/")}`
      : undefined;

    const result = await prisma.$transaction(async (tx) => {
      const updatedApplication = await tx.application.update({
        where: { id: application.id },
        data: {
          formData: updatedFormData,
          status: "awaiting_payment_confirmation" as any,
          declineReason: null,
        },
      });
      const updatedPayment = await tx.payment.update({
        where: { id: claim.id },
        data: {
          matchStatus: "awaiting_verification",
          ...(proofUrl
            ? {
                proofUrl,
                proofUploadedById: userId,
                proofUploadedAt: new Date(),
              }
            : {}),
        },
      });
      return { updatedApplication, updatedPayment };
    });

    await prisma.auditLog.create({
      data: {
        action: "invoice_adjusted",
        entity: "Payment",
        entityId: claim.id,
        userId,
        details: {
          stage: "fo_correction_resubmitted",
          applicationId: application.id,
          proofReplaced: !!proofUrl,
        },
        ipAddress: getIp(req),
      },
    });

    return sendSuccess(
      res,
      { payment: result.updatedPayment },
      "Correction sent. Awaiting treasurer confirmation.",
    );
  } catch (err) {
    next(err);
  }
};
