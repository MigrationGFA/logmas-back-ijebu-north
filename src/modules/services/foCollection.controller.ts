import { Request, Response, NextFunction } from "express";
import { sendSuccess, sendError } from "../../utils/response";
import { prisma } from "../../utils/prisma";
import { generateReference } from "../../utils/generators";
import { Role } from "@prisma/client";
import { sendSms } from "../notification/sms.service";

/** Termii wants international format; payers give local Nigerian numbers. */
const normalizeNgPhone = (raw: string): string | null => {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("234") && digits.length >= 12) return digits;
  if (digits.startsWith("0") && digits.length === 11)
    return `234${digits.slice(1)}`;
  if (digits.length === 10) return `234${digits}`;
  return null;
};

/**
 * POST /api/v1/services/fo-collections
 *
 * Field-officer collection for an FO-only service.
 *
 * The officer selects the service first (the catalogue carries only
 * FO-only services for staff), then records who paid, how much was
 * actually paid after bargaining, and the merchant where there is one.
 * There is no fixed fee for these services. The account the payer
 * transfers to is the LGA collection account kept in the database
 * (lga_bank_accounts, managed by treasurer/admin in Settings): the
 * invoice page shows it, and on creation the payer is sent it by SMS
 * together with the service, the amount and the officer's phone
 * number, so they can send the officer their transfer receipt.
 *
 * Submitting creates BOTH the application and its invoice in one
 * transaction. The officer then records the transfer on the invoice
 * page with the payer's proof, which parks the pair at
 * `awaiting_payment_confirmation` for the treasurer.
 */
export const createFoCollection = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const officerId = req.user!.id;
    const role = req.user!.role as Role;

    const allowedRoles: Role[] = [
      "field_officer",
      "sub_admin",
      "lga_admin",
      "super_admin",
    ];
    if (!allowedRoles.includes(role)) {
      return sendError(
        res,
        "Only field officers can record FO-only service collections",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const { serviceCode, payerName, phone, email, merchantName, location, amount } =
      req.body || {};

    const paidAmount = Number(amount);
    if (!serviceCode || !payerName || !phone || !location) {
      return sendError(
        res,
        "Missing required fields: serviceCode, payerName, phone, location",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }
    if (!paidAmount || paidAmount <= 0) {
      return sendError(
        res,
        "Amount paid must be greater than 0",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }

    const service = await prisma.service.findFirst({
      where: { code: String(serviceCode), isActive: true },
    });
    if (!service) {
      return sendError(res, "Service not found", "NOT_FOUND", null, 404);
    }
    if (!service.foOnly) {
      return sendError(
        res,
        "This endpoint is only for FO-only services",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const formData = {
      _foCollection: true,
      payerName: String(payerName),
      phone: String(phone),
      email: email ? String(email) : null,
      merchantName: merchantName ? String(merchantName) : null,
      location: String(location),
      amountPaid: paidAmount,
      serviceName: service.name,
    };

    const result = await prisma.$transaction(async (tx) => {
      const application = await tx.application.create({
        data: {
          applicationNumber: generateReference("INE-APP"),
          serviceId: service.id,
          feeAmount: paidAmount,
          status: "submitted",
          formData: formData as any,
          applicantId: officerId,
          createdById: officerId,
        },
      });

      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber: generateReference("INE-INV"),
          applicationId: application.id,
          serviceId: service.id,
          amount: paidAmount,
          paymentStatus: "pending",
          // No virtual account fields: FO collections are paid into the
          // LGA collection account from lga_bank_accounts, resolved at
          // display and SMS time, never stored per invoice.
          createdById: officerId,
        },
      });

      await tx.auditLog.create({
        data: {
          action: "invoice_created",
          entity: "FoCollection",
          entityId: application.id,
          userId: officerId,
          details: {
            serviceCode: service.code,
            serviceName: service.name,
            payerName: formData.payerName,
            merchantName: formData.merchantName,
            amount: paidAmount,
            invoiceNumber: invoice.invoiceNumber,
          } as any,
        },
      });

      return { application, invoice };
    });

    // Text the payer the payment details. Best effort by design: an SMS
    // failure (or no account saved yet) never fails the collection.
    let smsSent = false;
    try {
      const bankAccount = await prisma.lgaBankAccount.findFirst({
        orderBy: { createdAt: "asc" },
      });
      const to = normalizeNgPhone(String(phone));
      if (bankAccount && to) {
        const officer = await prisma.user.findUnique({
          where: { id: officerId },
          select: { phone: true },
        });
        const message = [
          "Ijebu North East Local Government",
          `Invoice: ${result.invoice.invoiceNumber}`,
          `Service: ${service.name}`,
          `Amount: NGN ${paidAmount.toLocaleString("en-NG")}`,
          "",
          "Pay to:",
          bankAccount.bankName,
          `Acct No: ${bankAccount.accountNumber}`,
          `Acct Name: ${bankAccount.accountName}`,
          "",
          `After payment, please send your receipt to your field officer${officer?.phone ? ` on ${officer.phone}` : ""}.`,
        ].join("\n");
        const sms = await sendSms({ to, message });
        smsSent = sms.success;
      }
    } catch (smsErr) {
      console.error("[foCollection] payment-details SMS failed:", smsErr);
    }

    return sendSuccess(
      res,
      { ...result, smsSent },
      smsSent
        ? "Collection recorded. Payment details sent to the payer by SMS."
        : "Collection recorded. Continue to the invoice page for the bank details.",
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/invoices/:id/resend-payment-link
 *
 * Re-sends an FO collection's payment instructions to the payer by SMS.
 * channel "transfer" re-sends the saved LGA collection account details
 * (the same message the payer got when the collection was created);
 * channel "card" sends the public /pay/:invoiceNumber link, which starts
 * a Paystack payment for this invoice when opened. The collecting officer
 * can resend for their own collections; treasurer and admin roles can
 * resend for any. Refused while the invoice is settled or a recorded
 * transfer is awaiting confirmation, so a payer can never be pushed to
 * pay twice.
 */
export const resendPaymentInstructions = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user!.id;
    const role = req.user!.role as Role;

    const allowedRoles: Role[] = [
      "field_officer",
      "treasurer",
      "lga_admin",
      "super_admin",
    ];
    if (!allowedRoles.includes(role)) {
      return sendError(
        res,
        "You cannot resend payment instructions",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const invoice = await prisma.invoice.findUnique({
      where: { invoiceNumber: String(req.params.id) },
      include: { application: true, service: true },
    });
    if (!invoice)
      return sendError(res, "Invoice not found", "NOT_FOUND", null, 404);

    const formData =
      invoice.application?.formData &&
      typeof invoice.application.formData === "object"
        ? (invoice.application.formData as Record<string, any>)
        : {};
    const isFoInvoice = invoice.service?.foOnly ?? formData._foCollection === true;
    if (!isFoInvoice) {
      return sendError(
        res,
        "This invoice is not a field officer collection",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    if (
      role === "field_officer" &&
      invoice.application?.createdById !== userId
    ) {
      return sendError(
        res,
        "You can only resend instructions for your own collections",
        "FORBIDDEN",
        null,
        403,
      );
    }

    if (["paid", "cancelled", "confirmed"].includes(invoice.paymentStatus)) {
      return sendError(
        res,
        "This invoice has already been paid or cancelled",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const pendingClaim = await prisma.payment.findFirst({
      where: {
        invoiceId: invoice.id,
        method: "bank_transfer",
        status: "pending",
        OR: [
          { matchStatus: "awaiting_verification" },
          { proofUrl: { not: null } },
        ],
      },
    });
    if (pendingClaim) {
      return sendError(
        res,
        "A bank transfer for this invoice is awaiting confirmation, so payment instructions cannot be resent yet.",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const to = normalizeNgPhone(String(formData.phone ?? ""));
    if (!to) {
      return sendError(
        res,
        "This collection has no valid payer phone number",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const officer = invoice.application?.createdById
      ? await prisma.user.findUnique({
          where: { id: invoice.application.createdById },
          select: { phone: true },
        })
      : null;
    const officerLine = `After payment, please send your receipt to your field officer${officer?.phone ? ` on ${officer.phone}` : ""}.`;
    const amount = Number(invoice.amount).toLocaleString("en-NG");
    const channel = req.body?.channel === "card" ? "card" : "transfer";

    let message: string;
    if (channel === "card") {
      const email =
        (typeof req.body?.email === "string" && req.body.email) ||
        (typeof formData.email === "string" && formData.email) ||
        null;
      if (!email) {
        return sendError(
          res,
          "Add the payer's email address to send a card payment link.",
          "EMAIL_REQUIRED",
          null,
          400,
        );
      }
      const portal = (process.env.APP_URL || "").replace(/\/$/, "");
      message = [
        "Ijebu North East Local Government",
        `Invoice: ${invoice.invoiceNumber}`,
        `Service: ${invoice.service?.name ?? formData.serviceName ?? "Service"}`,
        `Amount: NGN ${amount}`,
        "",
        "Pay by card:",
        `${portal}/pay/${invoice.invoiceNumber}`,
        "",
        officerLine,
      ].join("\n");
    } else {
      const bankAccount = await prisma.lgaBankAccount.findFirst({
        orderBy: { createdAt: "asc" },
      });
      if (!bankAccount) {
        return sendError(
          res,
          "No collection account has been saved yet. Ask the treasurer or admin to save it in Settings.",
          "BAD_REQUEST",
          null,
          400,
        );
      }
      message = [
        "Ijebu North East Local Government",
        `Invoice: ${invoice.invoiceNumber}`,
        `Service: ${invoice.service?.name ?? formData.serviceName ?? "Service"}`,
        `Amount: NGN ${amount}`,
        "",
        "Pay to:",
        bankAccount.bankName,
        `Acct No: ${bankAccount.accountNumber}`,
        `Acct Name: ${bankAccount.accountName}`,
        "",
        officerLine,
      ].join("\n");
    }

    const sms = await sendSms({ to, message });
    return sendSuccess(
      res,
      { smsSent: sms.success, channel },
      sms.success
        ? "Payment instructions sent to the payer by SMS."
        : "The SMS could not be sent. Check the number and try again.",
    );
  } catch (err) {
    next(err);
  }
};
