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
