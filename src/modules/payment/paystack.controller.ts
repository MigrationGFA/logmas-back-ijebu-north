import { Request, Response, NextFunction } from "express";

import { completeNewApplicationAfterPayment, confirmPayment } from "./payment.service";
import { prisma } from "../../utils/prisma";
import { sendError, sendSuccess } from "../../utils/response";
import { generateReference } from "../../utils/generators";
import {
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature,
} from "./paystack.service";
import {
  interpolate,
  NotificationTemplates,
} from "../../config/notification.template";
import { sendSms } from "../notification/sms.service";
import { sendEmail } from "../notification/email.service";

// POST /api/v1/invoices/:id/pay-online
// Replaces the online-payment stub inside your existing recordInvoicePayment.
// `:id` is the invoiceNumber, matching your existing convention.

 const callbackUrl = process.env.NODE_ENV === "production"
      ? `${process.env.PAYSTACK_CALLBACK_URL}/payment/result`
      : "http://localhost:3002/payment/result";

export const initializePaystackPayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const userEmail = req.user!.email;

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
    
    const reference = generateReference("PAY");
    const amountKobo = Math.round(Number(invoice.amount) * 100);
    
    const gatewayResult = await initializeTransaction({
      email: userEmail,
      amountKobo,
      reference,
      callbackUrl,
      metadata: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        userId,
      },
    });
    
    console.log("✅ 1",gatewayResult,userEmail)
    if (!gatewayResult.success) {
      return sendError(
        res,
        gatewayResult.error ?? "Failed to initialize payment",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    console.log("❤️ 2")
    // Create a pending Payment row now so verify/webhook have something to match against by reference.
    await prisma.payment.create({
      data: {
        invoice: { connect: { id: invoice.id } },
        amount: Number(invoice.amount),
        method: "online_gateway",
        status: "pending",
        reference,
        paidBy: { connect: { id: userId } },
      },
    });

    return sendSuccess(res, {
      paymentUrl: gatewayResult.data!.authorization_url,
      reference: gatewayResult.data!.reference,
      message: "Redirect user to paymentUrl to complete payment",
    });
  } catch (err) {
    next(err);
  }
};

interface NewFlowPaymentBody {
  serviceId: string;
  fullName: string;
  email: string;
  phone: string;
}

export const initializePaystackPaymentNewFlow = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {

    const { serviceId, fullName, email, phone } =
    req.body as NewFlowPaymentBody;
    
    if (!serviceId || !fullName || !email || !phone) {
      return sendError(
        res,
        "Service ID, full name, email and phone number are required",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }

    // 1. Get service + current fee
    const service = await prisma.service.findUnique({
      where: { id: serviceId },
      include: {
        feeConfig: true,
      },
    });

    if (!service) {
      return sendError(
        res,
        "Service not found",
        "NOT_FOUND",
        null,
        404,
      );
    }

    if (!service.isActive) {
      return sendError(
        res,
        "Service is not active",
        "SERVICE_INACTIVE",
        null,
        400,
      );
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

    const amount = Number(service.feeConfig.amount);
    const amountKobo = Math.round(amount * 100);

    // 2. Check whether the person already has an account.
    // We DON'T create anything yet.
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: {
        id: true,
        email: true,
        role: true,
      },
    });

    // 3. Generate Paystack reference
    const reference = generateReference("PAY");

    // 4. Everything needed to finish the application later
    const metadata = {
      flow: "new_application",
      serviceId: service.id,
      serviceCode: service.code,
      serviceName: service.name,
      fullName: fullName.trim(),
      email: email.toLowerCase().trim(),
      phone: phone.trim(),

      // Useful if the person already exists
      userId: existingUser?.id ?? null,
    };

    // 5. Initialize Paystack
    const gatewayResult = await initializeTransaction({
      email: email.toLowerCase().trim(),
      amountKobo,
      reference,
      callbackUrl,
      metadata,
    });

    if (!gatewayResult.success) {
      return sendError(
        res,
        gatewayResult.error ?? "Failed to initialize payment",
        "PAYMENT_INITIALIZATION_FAILED",
        null,
        400,
      );
    }

    return sendSuccess(res, {
      paymentUrl: gatewayResult.data!.authorization_url,
      reference: gatewayResult.data!.reference,
      amount,
      serviceId: service.id,
      flow: "new_application",
    });
  } catch (err) {
    next(err);
  }
};

export const verifyPaystackPayment = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const reference = req.params.reference as string;

    // 1. Ask Paystack what happened
    const verifyResult = await verifyTransaction(reference);

    if (!verifyResult.success) {
      return sendError(
        res,
        verifyResult.error ?? "Failed to verify with Paystack",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    // 2. Payment was not successful
    if (verifyResult.data!.status !== "success") {
      return sendSuccess(res, {
        status: verifyResult.data!.status,
        reference,
      });
    }

    // 3. Check Paystack metadata
    const metadata = verifyResult.data!.metadata as any;

    // =====================================================
    // NEW PUBLIC PAYMENT FLOW
    // =====================================================

    if (metadata?.flow === "new_application") {
      const result = await completeNewApplicationAfterPayment({
        paymentReference: reference,
        amount: verifyResult.data!.amountKobo / 100,
        gatewayRef: reference,
        metadata,
      });

      const payload: any = {
        status: "confirmed",
        flow: "new_application",
        ...result,
      };

      // Payment settled, but the confirmation/credentials email failed —
      // return an error (details keep the settlement facts for the result
      // page, which renders "paid, but the email failed").
      if (payload.emailSent === false) {
        return sendError(
          res,
          `Payment confirmed for ${reference}, but the confirmation email could not be sent. Contact the LGA with this reference.`,
          "EMAIL_SEND_FAILED",
          payload,
          502,
        );
      }

      return sendSuccess(res, payload);
    }

    // =====================================================
    // EXISTING PAYMENT FLOW
    // =====================================================

    const payment = await prisma.payment.findUnique({
      where: { reference },
      include: { invoice: true },
    });

    if (!payment) {
      return sendError(
        res,
        "Payment reference not found",
        "NOT_FOUND",
        null,
        404,
      );
    }

    const paymentWithInvoice = payment as typeof payment & {
      invoice: any;
    };

    // Already confirmed
    if (paymentWithInvoice.status === "confirmed") {
      return sendSuccess(res, {
        status: "confirmed",
        payment: paymentWithInvoice,
        invoice: paymentWithInvoice.invoice,
      });
    }

    // Confirm existing-flow payment
    const confirmResult = await confirmPayment({
      invoiceId: paymentWithInvoice.invoiceId,
      amount: verifyResult.data!.amountKobo / 100,
      method: "online_gateway",
      reference,
      gatewayRef: reference,
      paidById: paymentWithInvoice.paidById,
      confirmedById: null,
    });

    return sendSuccess(res, {
      status: "confirmed",
      payment: confirmResult.payment,
      invoice: confirmResult.invoice,
      receipt: confirmResult.receipt,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/v1/payments/webhook
export const paystackWebhook = async (req: Request, res: Response) => {
  const signature = req.headers["x-paystack-signature"] as string | undefined;
  const rawBody = req.body as Buffer;

  if (!verifyWebhookSignature(rawBody, signature)) {
    return res
      .status(401)
      .json({
        success: false,
        message: "Invalid webhook signature",
      });
  }

  // Acknowledge Paystack immediately
  res.status(200).json({ received: true });

  try {
    const event = JSON.parse(rawBody.toString("utf8"));

    if (event.event !== "charge.success") {
      return;
    }

    const {
      reference,
      amount,
      metadata,
    } = event.data;

    // =====================================================
    // NEW PUBLIC APPLICATION FLOW
    // =====================================================

    if (metadata?.flow === "new_application") {
      await completeNewApplicationAfterPayment({
        paymentReference: reference,
        amount: amount / 100,
        gatewayRef: reference,
        metadata,
      });

      return;
    }

    // =====================================================
    // EXISTING FLOW
    // =====================================================

    const payment = await prisma.payment.findUnique({
      where: {
        reference: reference as string,
      },
    });

    if (!payment) {
      console.error(
        `[paystack.webhook] No payment found for reference ${reference}`,
      );
      return;
    }

    await confirmPayment({
      invoiceId: payment.invoiceId,
      amount: amount / 100,
      method: "online_gateway",
      reference: reference as string,
      gatewayRef: reference as string,
      paidById: payment.paidById,
      confirmedById: null,
    });

  } catch (err) {
    console.error(
      "[paystack.webhook] processing error:",
      err,
    );
  }
};

// POST /api/v1/invoices/:id/send-payment-link
// export const sendPaymentLinkToBusiness = async (
//   req: Request,
//   res: Response,
//   next: NextFunction,
// ) => {
//   try {
//     const { id } = req.params; 
//     const role = req.user!.role;

//     if (!["field_officer", "lga_admin", "super_admin"].includes(role)) {
//       return sendError(
//         res,
//         "Only field officers can send payment links",
//         "FORBIDDEN",
//         null,
//         403,
//       );
//     }

//     const invoice = await prisma.invoice.findUnique({
//       where: { invoiceNumber: String(id) },
//       include: { business: true },
//     });
//     if (!invoice)
//       return sendError(res, "Invoice not found", "NOT_FOUND", null, 404);
//     if (!invoice.business) {
//       return sendError(
//         res,
//         "This invoice has no linked business",
//         "BAD_REQUEST",
//         null,
//         400,
//       );
//     }
//     if (["paid", "cancelled"].includes(invoice.status)) {
//       return sendError(
//         res,
//         "Invoice is already paid or cancelled",
//         "BAD_REQUEST",
//         null,
//         400,
//       );
//     }

//     const business = invoice.business;

//     const isTestMode = process.env.NOTIFICATION_TEST_MODE !== "false";
//     const recipientEmail = isTestMode
//       ? process.env.TEST_RECIPIENT_EMAIL
//       : business.email;
//     const recipientPhone = isTestMode
//       ? process.env.TEST_RECIPIENT_PHONE
//       : business.phone;

//     if (!recipientEmail) {
//       return sendError(
//         res,
//         isTestMode
//           ? "TEST_RECIPIENT_EMAIL is not set in .env"
//           : "This business has no email on file. Add one before sending a payment link.",
//         "BAD_REQUEST",
//         null,
//         400,
//       );
//     }

//     const reference = generateReference("PAY");
//     const amountKobo = Math.round(Number(invoice.balanceDue) * 100);

//     // Ensure callbackUrl is defined (using fallback or env var)
//     const callbackUrl = process.env.PAYSTACK_CALLBACK_URL;

//     const gatewayResult = await initializeTransaction({
//       email: recipientEmail,
//       amountKobo,
//       reference,
//       callbackUrl,
//       metadata: {
//         invoiceId: invoice.id,
//         invoiceNumber: invoice.invoiceNumber,
//         businessId: business.id,
//       },
//     });

//     if (!gatewayResult.success) {
//       return sendError(
//         res,
//         gatewayResult.error ?? "Failed to initialize payment",
//         "BAD_REQUEST",
//         null,
//         400,
//       );
//     }

//     await prisma.payment.create({
//       data: {
//         invoice: { connect: { id: invoice.id } },
//         amount: Number(invoice.balanceDue),
//         method: "online_gateway",
//         status: "pending",
//         reference,
//       },
//     });

//     const checkoutLink = gatewayResult.data!.authorization_url;
//     const vars = {
//       business_name: business.businessName,
//       payment_amount: `₦${Number(invoice.balanceDue).toLocaleString()}`,
//       checkout_link: checkoutLink,
//       permit_type: invoice.description ?? "Trade Permit",
//     };

//     const template = NotificationTemplates.permit.invoiceGenerated;

//     // Initialize tracking flags
//     let smsSent = false;
//     let emailSent = false;

//     // 💡 Decoupled parallel execution with independent try/catch shields
//     await Promise.all([
//       (async () => {
//         try {
//           if (recipientPhone) {
//             const smsResult = await sendSms({
//               to: recipientPhone.replace("+", ""),
//               message: interpolate(template.sms, vars),
//             });
//             smsSent = !!smsResult?.success;
//           }
//         } catch (smsErr) {
//           console.error("[Notification Error] SMS transmission pipeline failed:", smsErr);
//           smsSent = false; // Graceful isolation: API keeps running
//         }
//       })(),
      
//       (async () => {
//         try {
//           const emailResult = await sendEmail({
//             to: recipientEmail,
//             subject: interpolate(template.emailSubject, vars),
//             html: interpolate(template.emailHtml, vars),
//           });
//           emailSent = !!emailResult?.success;
//         } catch (emailErr) {
//           console.error("[Notification Error] Email transmission pipeline failed:", emailErr);
//           emailSent = false; // Graceful isolation: API keeps running
//         }
//       })()
//     ]);

//     return sendSuccess(res, {
//       reference,
//       checkoutLink,
//       smsSent,
//       emailSent,
//     });
//   } catch (err) {
//     next(err);
//   }
// };

/**
 * GET /api/v1/public/payments?page=1&limit=20
 * Public, unauthenticated. Returns all PAID invoices across the system —
 * State of Origin certificates, trade permits, and levies alike — since all
 * three are just Invoices with a different linked parent record.
 */
// export const getAllPaidServices = async (req: Request, res: Response, next: NextFunction) => {
//   try {
//     const page = Math.max(Number(req.query.page ?? 1), 1);
//     const limit = Math.min(Number(req.query.limit ?? 20), 100); // cap to prevent abuse on a public route

//     const where = { status: "paid" as const };

//     const [invoices, total] = await Promise.all([
//       prisma.invoice.findMany({
//         where,
//         orderBy: { paidAt: "desc" },
//         skip: (page - 1) * limit,
//         take: limit,
//         include: {
//           category: { select: { name: true, type: true } },
//           business: {
//             select: {
//               businessName: true,
//               ownerName: true,
//               ward: { select: { name: true } },
//             },
//           },
//           stateOfOriginApplication: {
//             select: {
//               fullName: true,
//               ward: { select: { name: true } },
//             },
//           },
//           permit: {
//             select: {
//               permitNumber: true,
//               config: { select: { name: true } },
//             },
//           },
//         },
//       }),
//       prisma.invoice.count({ where }),
//     ]);

//     const results = invoices.map((inv) => {
//       // Exactly one of these two relations can be set per invoice (schema-enforced
//       // via unique invoiceId on each side) — a plain levy invoice has neither.
//       const isStateOfOrigin = !!inv.stateOfOriginApplication;
//       const isPermit = !!inv.permit;
//       const type = isStateOfOrigin ? "state_of_origin" : isPermit ? "permit" : "levy";

//       const owner = isStateOfOrigin
//         ? inv.stateOfOriginApplication!.fullName
//         : (inv.business?.ownerName ?? inv.business?.businessName ?? "Unknown");

//       const lga = "Ijebu North East LGA"

//       return {
//         invoiceId: inv.id,
//         invoiceNumber: inv.invoiceNumber,
//         type,
//         serviceName: isPermit
//           ? (inv.permit!.config?.name ?? "Trade Permit")
//           : (inv.category?.name ?? inv.description),
//         owner,
//         amount: Number(inv.totalAmount),
//         lga,
//         status: inv.status,
//         paidAt: inv.paidAt,
//       };
//     });

//     return sendSuccess(res, {
//       results,
//       pagination: {
//         page,
//         limit,
//         total,
//         totalPages: Math.ceil(total / limit),
//       },
//     });
//   } catch (err) {
//     next(err);
//   }
// };