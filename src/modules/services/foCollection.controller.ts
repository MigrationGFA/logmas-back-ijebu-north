import { Request, Response, NextFunction } from "express";
import { sendSuccess, sendError } from "../../utils/response";
import { prisma } from "../../utils/prisma";
import { generateReference } from "../../utils/generators";
import { Role } from "@prisma/client";

/**
 * POST /api/v1/services/fo-collections
 *
 * Field-officer collection for an FO-only service.
 *
 * The officer selects the service first (the catalogue carries only
 * FO-only services for staff), then records who paid, how much was
 * actually paid after bargaining, and the merchant where there is one.
 * There is no fixed fee for these services and no bank details are
 * shown or stored: the platform's job is the record (how much, which
 * officer initiated it, which merchant), while settlement happens
 * out of band and the treasurer confirms afterwards.
 *
 * Submitting creates BOTH the application and its invoice in one
 * transaction. The officer is then sent to the invoice page to record
 * how the payer paid (cash or bank transfer), which parks the pair at
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
          // No virtual account fields on purpose: no bank details are
          // displayed for FO-only services.
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

    return sendSuccess(
      res,
      result,
      "Collection recorded. Choose how the payer paid on the invoice page.",
    );
  } catch (err) {
    next(err);
  }
};
