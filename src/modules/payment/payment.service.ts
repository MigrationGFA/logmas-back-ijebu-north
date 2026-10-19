// src/payments/payment.service.ts
import { PaymentMethod, PaymentStatus } from "@prisma/client";
import { prisma } from "../../utils/prisma";
import {
  generateReference,
  generateReceiptNumber,
  generateVerificationCode,
  generateQrToken,
} from "../../utils/generators";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { notify } from "../notification/notification.service";

interface ConfirmPaymentParams {
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  reference?: string;
  gatewayRef?: string;
  narration?: string;
  paidById?: string | null;
  confirmedById?: string | null;
}

interface ConfirmPaymentResult {
  alreadyProcessed: boolean;
  payment: any;
  invoice: any;
  receipt: any | null;
  isFullPayment: boolean;
}

/**
 * Confirms a payment against an invoice: creates the Payment row, updates the invoice's
 * amountPaid/balanceDue/status, and generates a Receipt on full payment.
 */
export async function confirmPayment({
  invoiceId,
  amount,
  method,
  reference,
  gatewayRef,
  narration,
  paidById,
  confirmedById,
}: ConfirmPaymentParams): Promise<ConfirmPaymentResult> {
  const finalReference = reference || generateReference("PAY");

  // ---------------------------------------------------------
  // 1. Idempotency check
  // ---------------------------------------------------------
  const existingPayment = await prisma.payment.findUnique({
    where: {
      reference: finalReference,
    },
  });

  if (existingPayment?.status === "confirmed") {
    const invoice = await prisma.invoice.findUnique({
      where: {
        id: invoiceId,
      },
    });

    const receipt = await prisma.receipt.findUnique({
      where: {
        invoiceId,
      },
    });

    if (!invoice) {
      throw new Error(`Invoice ${invoiceId} not found`);
    }

    const confirmedPayments = await prisma.payment.aggregate({
      where: {
        invoiceId,
        status: "confirmed",
      },
      _sum: {
        amount: true,
      },
    });

    const amountPaid = Number(confirmedPayments._sum.amount || 0);

    const balanceDue = Math.max(Number(invoice.amount) - amountPaid, 0);

    return {
      alreadyProcessed: true,
      payment: existingPayment,
      invoice,
      receipt,
      isFullPayment: balanceDue === 0,
    };
  }

  // ---------------------------------------------------------
  // 2. Get invoice
  // ---------------------------------------------------------
  const invoice = await prisma.invoice.findUnique({
    where: {
      id: invoiceId,
    },
  });

  if (!invoice) {
    throw new Error(`Invoice ${invoiceId} not found`);
  }

  // ---------------------------------------------------------
  // 3. Calculate current payment position
  //    Invoice.amount is the authoritative invoice amount.
  //    Payment records determine how much has been paid.
  // ---------------------------------------------------------
  const confirmedPayments = await prisma.payment.aggregate({
    where: {
      invoiceId,
      status: "confirmed",
    },
    _sum: {
      amount: true,
    },
  });

  const amountAlreadyPaid = Number(confirmedPayments._sum.amount || 0);

  const invoiceAmount = Number(invoice.amount);

  const remainingBeforePayment = Math.max(invoiceAmount - amountAlreadyPaid, 0);

  const newAmountPaid = amountAlreadyPaid + Number(amount);

  const newBalanceDue = Math.max(invoiceAmount - newAmountPaid, 0);

  const isFullPayment = newBalanceDue === 0;


  await prisma.auditLog.create({
    data: {
      action: "payment_confirmed",
      entity: "payment",
      entityId: existingPayment?.id ?? "",
      userId: confirmedById,
      details: {
        amount,
        invoiceId,
        method,
        status: "confirmed",
      },
    },
  });

  // ---------------------------------------------------------
  // 4. Create/confirm payment + receipt atomically
  // ---------------------------------------------------------
  const result = await prisma.$transaction(async (tx) => {
    const payment = existingPayment
      ? await tx.payment.update({
          where: {
            id: existingPayment.id,
          },
          data: {
            status: "confirmed",
            gatewayRef,
            confirmedAt: new Date(),
            confirmedById,
          },
        })
      : await tx.payment.create({
          data: {
            invoice: {
              connect: {
                id: invoiceId,
              },
            },
            amount,
            method,
            status: "confirmed",
            reference: finalReference,
            gatewayRef,
            narration,
            confirmedAt: new Date(),
            confirmedById,
            paidBy: paidById
              ? {
                  connect: {
                    id: paidById,
                  },
                }
              : undefined,
          },
        });

    // Remove stale pending payment attempts for this invoice.
    await tx.payment.deleteMany({
      where: {
        invoiceId,
        status: "pending",
        id: {
          not: payment.id,
        },
      },
    });

    await tx.invoice.update({
      where: {
        id: invoiceId,
      },
      data: {
        paymentStatus: isFullPayment ? "confirmed" : "failed",
        // Stamp the payment date exactly once, when the invoice is fully
        // settled. Without this the ledger shows confirmed invoices with a
        // null paidAt (the field was only ever set at invoice creation).
        paidAt: isFullPayment ? (invoice.paidAt ?? new Date()) : invoice.paidAt,
      },
    });

    // -------------------------------------------------------
    // 5. Create receipt only when invoice is fully paid
    // -------------------------------------------------------
    let receipt = null;

    if (isFullPayment) {
      const existingReceipt = await tx.receipt.findUnique({
        where: {
          invoiceId,
        },
      });

      if (existingReceipt) {
        receipt = existingReceipt;
      } else {
        const issuerId = confirmedById || paidById || invoice.createdById;

        receipt = await tx.receipt.create({
          data: {
            receiptNumber: generateReceiptNumber("RCP"),
            verificationCode: generateVerificationCode(),
            qrToken: generateQrToken(),
            amountPaid: newAmountPaid,
            invoice: {
              connect: {
                id: invoiceId,
              },
            },
            issuedBy: issuerId
              ? {
                  connect: {
                    id: issuerId,
                  },
                }
              : undefined,
          },
        });
      }
    }

    return {
      payment,
      invoice,
      receipt,
    };
  });

  return {
    alreadyProcessed: false,
    ...result,
    isFullPayment,
  };
}

interface NewApplicationPaymentParams {
  paymentReference: string;
  amount: number;
  gatewayRef?: string;
  metadata: {
    flow: string;
    serviceId: string;
    fullName: string;
    email: string;
    phone: string;
    userId?: string | null;
  };
}

export const completeNewApplicationAfterPayment = async ({
  paymentReference,
  amount,
  gatewayRef,
  metadata,
}: NewApplicationPaymentParams) => {
  const result = await prisma.$transaction(async (tx) => {
    // --------------------------------------------------
    // 1. IDEMPOTENCY CHECK
    // --------------------------------------------------

    const existingPayment = await tx.payment.findUnique({
      where: {
        reference: paymentReference,
      },
      include: {
        invoice: {
          include: {
            application: true,
          },
        },
      },
    });

    // Already processed by webhook or frontend verification
    if (existingPayment?.status === "confirmed") {
      return {
        alreadyProcessed: true,
        applicationId: existingPayment.invoice?.application?.id ?? null,
        invoiceId: existingPayment.invoiceId ?? null,
        paymentId: existingPayment.id,
        receiptId: await tx.receipt
          .findUnique({
            where: {
              invoiceId: existingPayment.invoiceId,
            },
            select: {
              id: true,
            },
          })
          .then((receipt) => receipt?.id ?? null),
        userId: existingPayment.invoice?.application?.applicantId ?? null,
        newUserCreated: false,
      };
    }

    // --------------------------------------------------
    // 2. FIND / CREATE USER
    // --------------------------------------------------

    const email = metadata.email.toLowerCase().trim();

    let user = await tx.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
      },
    });

    let newUserCreated = false;
    let generatedPassword: string | null = null;

    if (!user) {
      generatedPassword = crypto.randomBytes(6).toString("base64url");

      const nameParts = metadata.fullName.trim().split(/\s+/);

      const firstName = nameParts.shift() || "";
      const lastName = nameParts.join(" ") || firstName;

      const hashedPassword = await bcrypt.hash(generatedPassword, 10);

      user = await tx.user.create({
        data: {
          email,
          phone: metadata.phone.trim(),
          firstName,
          lastName,
          password: hashedPassword,
          role: "citizen",
          passwordResetRequired: true,
          onboardingCompleted: false,
          emailVerifiedAt: new Date(),
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      });

      newUserCreated = true;
    }

    // --------------------------------------------------
    // 3. GET SERVICE
    // --------------------------------------------------

    const service = await tx.service.findUnique({
      where: {
        id: metadata.serviceId,
      },
      include: {
        feeConfig: true,
      },
    });

    if (!service) {
      throw new Error("Service not found");
    }

    if (!service.isActive) {
      throw new Error("Service is no longer active");
    }

    if (!service.feeConfig || service.feeConfig.status !== "ACTIVE") {
      throw new Error("Service fee is no longer configured");
    }

    const feeAmount = service.feeConfig.amount;

    // --------------------------------------------------
    // 4. CREATE APPLICATION
    // --------------------------------------------------

    const application = await tx.application.create({
      data: {
        applicationNumber: generateReceiptNumber("APP"),
        service: {
          connect: {
            id: service.id,
          },
        },
        applicant: {
          connect: {
            id: user.id,
          },
        },
        createdBy: {
          connect: {
            id: user.id,
          },
        },
        feeAmount,
        formData: {},
        status: "awaiting_form",
      },
      select: {
        id: true,
        applicationNumber: true,
        status: true,
        feeAmount: true,
        createdAt: true,
        serviceId: true,
        applicantId: true,
        service:{
          select:{
            name:true
          }
        }
      },
    });


    // --------------------------------------------------
    // 5. CREATE INVOICE
    // --------------------------------------------------

    const invoice = await tx.invoice.create({
      data: {
        invoiceNumber: generateReceiptNumber("INV"),
        application: { connect: { id: application.id } },
        service: { connect: { id: service.id } },
        amount: feeAmount,
        paymentStatus: "confirmed",
        createdBy: { connect: { id: user.id } },
        paidAt: new Date(),
        transactionRef: paymentReference,
      },
      select: {
        id: true,
        invoiceNumber: true,
        amount: true,
        paymentStatus: true,
        paidAt: true,
        transactionRef: true,
        applicationId: true,
      },
    });

    // --------------------------------------------------
    // 6. CREATE CONFIRMED PAYMENT
    // --------------------------------------------------

    const payment = await tx.payment.create({
      data: {
        invoice: {
          connect: {
            id: invoice.id,
          },
        },
        amount,
        method: "online_gateway",
        status: "confirmed",
        reference: paymentReference,
        gatewayRef,
        paidBy: {
          connect: {
            id: user.id,
          },
        },
        confirmedAt: new Date(),
      },
      select: {
        id: true,
        amount: true,
        status: true,
        reference: true,
        gatewayRef: true,
        confirmedAt: true,
        invoiceId: true,
      },
    });

    // --------------------------------------------------
    // 7. CREATE RECEIPT
    // --------------------------------------------------

    const receipt = await tx.receipt.create({
      data: {
        receiptNumber: generateReceiptNumber("RCP"),
        verificationCode: generateVerificationCode(),
        qrToken: generateQrToken(),
        amountPaid: feeAmount,
        invoice: {
          connect: {
            id: invoice.id,
          },
        },
        issuedBy: {
          connect: {
            id: user.id,
          },
        },
      },
      select: {
        id: true,
        receiptNumber: true,
        verificationCode: true,
        qrToken: true,
        amountPaid: true,
        issuedAt: true,
        invoiceId: true,
      },
    });

    return {
      alreadyProcessed: false,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
      application: {
        id: application.id,
        applicationNumber: application.applicationNumber,
        status: application.status,
        feeAmount: application.feeAmount,
        createdAt: application.createdAt,
        serviceId: application.serviceId,
        applicantId: application.applicantId,
        serviceName: application.service?.name ?? "",
      },
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        amount: invoice.amount,
        paymentStatus: invoice.paymentStatus,
        paidAt: invoice.paidAt,
        transactionRef: invoice.transactionRef,
        applicationId: invoice.applicationId,
      },
      payment: {
        id: payment.id,
        amount: payment.amount,
        status: payment.status,
        reference: payment.reference,
        gatewayRef: payment.gatewayRef,
        confirmedAt: payment.confirmedAt,
        invoiceId: payment.invoiceId,
      },
      receipt: {
        id: receipt.id,
        receiptNumber: receipt.receiptNumber,
        verificationCode: receipt.verificationCode,
        qrToken: receipt.qrToken,
        amountPaid: receipt.amountPaid,
        issuedAt: receipt.issuedAt,
        invoiceId: receipt.invoiceId,
      },
      newUserCreated,
      generatedPassword,
    };
  });

  if (!result.alreadyProcessed && result.user) {
  const fullName =
    `${result.user.firstName} ${result.user.lastName}`.trim();

  // The confirmation email is part of this flow's contract: the generated
  // login credentials are ONLY delivered by email, so a silently-failed send
  // strands the new citizen with no way to log in. Capture every outcome
  // instead of swallowing it — the verify endpoint returns EMAIL_SEND_FAILED
  // when emailSent is false (the webhook path just logs it). The payment
  // itself is already settled either way.
  let emailSent = true;
  let emailFailReason: string | null = null;
  const noteEmailFailure = (label: string, reason: unknown) => {
    emailSent = false;
    const text =
      typeof reason === "string"
        ? reason
        : reason instanceof Error
          ? reason.message
          : JSON.stringify(reason);
    emailFailReason = `${label}: ${text}`;
  };

  if (result.newUserCreated) {
    try {
      const accountNotify = await notify({
        userId: result.user.id,
        to: {
          email: result.user.email,
          phone: metadata.phone?.trim() ?? "",
        },
        templateKey: "account.publicAccountCreated",
        vars: {
          applicant_name: fullName,
          application_number: result.application.applicationNumber,
          service_name: result.application.serviceName,
          application_id: result.application.id,
          fee_amount: result.application.feeAmount.toString(),
          temp_password: result.generatedPassword,
        },
        channels: ["email", "sms"],
      });
      if (accountNotify.email && !accountNotify.email.success) {
        noteEmailFailure(
          "credentials email",
          accountNotify.email.error ??
            (accountNotify.email.skipped
              ? "email channel unavailable (missing template or address)"
              : "unknown reason"),
        );
      }
    } catch (notifyErr) {
      console.error(
        "[completeNewApplicationAfterPayment] account notification failed:",
        notifyErr,
      );
      noteEmailFailure("credentials email", notifyErr);
    }
  }

  try {
    const completionNotify = await notify({
      userId: result.user.id,
      to: {
        email: result.user.email,
        phone: metadata.phone?.trim() ?? "",
      },
      templateKey: "application.completeApplication",
      vars: {
        applicant_name: fullName,
        application_number: result.application.applicationNumber,
        service_name: result.application.serviceName,
        application_id: result.application.id,
      },
      channels: ["email", "sms"],
    });
    if (completionNotify.email && !completionNotify.email.success) {
      noteEmailFailure(
        "completion email",
        completionNotify.email.error ??
          (completionNotify.email.skipped
            ? "email channel unavailable (missing template or address)"
            : "unknown reason"),
      );
    }
  } catch (notifyErr) {
    console.error(
      "[completeNewApplicationAfterPayment] completion notification failed:",
      notifyErr,
    );
    noteEmailFailure("completion email", notifyErr);
  }

  if (!emailSent) {
    console.error(
      `[completeNewApplicationAfterPayment] confirmation email NOT sent to ${result.user.email}: ${emailFailReason}`,
    );
  }

  Object.assign(result, { emailSent, emailFailReason });
}

  return result;
};
