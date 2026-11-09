import { Request, Response, NextFunction } from "express";
import { prisma } from "../../utils/prisma";
import { sendSuccess, sendError } from "../../utils/response";
import { generateReference } from "../../utils/generators";
import { LGA_CONFIG } from "../../config/lga.config";
import {
  DEDICATED_VIRTUAL_ACCOUNTS,
  DEFAULT_STATUTORY_ACCOUNT,
  SERVICE_CODE_BY_SERVICE,
} from "../payment/gpay.service";
import { sendEmail } from "../notification/email.service";

const PORTAL_URL = process.env.APP_URL || process.env.GPAY_RETURN_URL;

/**
 * Generate a unique Demand Notice Reference Number
 * Format: IFO/DN/2026/XXXXXX
 */
function generateDemandNoticeNumber(): string {
  const year = new Date().getFullYear();
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `IFO/DN/${year}/${rand}`;
}

/**
 * Resolve dedicated Providus Bank account for a service
 */
function resolveServiceProvidusAccount(serviceCode: string) {
  const gpayCode = SERVICE_CODE_BY_SERVICE[serviceCode] || serviceCode.toUpperCase();
  if (DEDICATED_VIRTUAL_ACCOUNTS[gpayCode]) {
    return DEDICATED_VIRTUAL_ACCOUNTS[gpayCode];
  }
  return DEFAULT_STATUTORY_ACCOUNT;
}

/**
 * 1. CREATE AND ISSUE A STATUTORY DEMAND NOTICE
 * POST /api/v1/demand-notices
 */
export const createDemandNotice = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const {
      payerType = "business", // "individual" | "business" | "property_owner"
      payerName,
      tradingName,
      rcNumber,
      phone,
      email,
      ward,
      address,
      serviceCode = "demand_notice",
      revenueHead = "2002 - Business & Commercial Demand Notices",
      chargeDescription = "Statutory Business Demand Notice & Municipal Assessment",
      assessmentItems = [],
      amountPayable,
      dueDate,
      notes,
    } = req.body;

    if (!payerName || !phone || !ward || !address || !amountPayable) {
      return sendError(
        res,
        "payerName, phone, ward, address, and amountPayable are required",
        "VALIDATION_ERROR",
        null,
        400
      );
    }

    const officerId = (req as any).user?.id || null;
    const finalAmount = Number(amountPayable);
    if (isNaN(finalAmount) || finalAmount <= 0) {
      return sendError(
        res,
        "amountPayable must be a positive number",
        "VALIDATION_ERROR",
        null,
        400
      );
    }

    // 1. Resolve Target Service in DB
    let targetService = await prisma.service.findFirst({
      where: {
        OR: [{ code: serviceCode }, { code: "demand_notice" }],
      },
    });

    if (!targetService) {
      targetService = await prisma.service.findFirst({
        where: { isActive: true },
      });
    }

    if (!targetService) {
      return sendError(res, "No valid municipal service found", "SERVICE_NOT_FOUND", null, 404);
    }

    // 2. Resolve dedicated Providus Virtual Account
    const bankDetails = resolveServiceProvidusAccount(targetService.code);

    // 3. Generate unique Notice Reference Number
    let noticeRef = generateDemandNoticeNumber();
    let isUnique = false;
    let attempts = 0;
    while (!isUnique && attempts < 5) {
      const existing = await prisma.application.findFirst({
        where: {
          formData: {
            path: ["demandNoticeNumber"],
            equals: noticeRef,
          },
        },
      });
      if (!existing) {
        isUnique = true;
      } else {
        noticeRef = generateDemandNoticeNumber();
        attempts++;
      }
    }

    // 4. Calculate default Due Date (14 calendar days from now if not specified)
    const finalDueDate = dueDate
      ? new Date(dueDate).toISOString()
      : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const formattedItems =
      Array.isArray(assessmentItems) && assessmentItems.length > 0
        ? assessmentItems
        : [{ description: chargeDescription, amount: finalAmount }];

    const noticeFormData = {
      demandNoticeNumber: noticeRef,
      payerType,
      payerName,
      tradingName: tradingName || payerName,
      rcNumber: rcNumber || null,
      phone,
      email: email || null,
      ward,
      address,
      serviceCode: targetService.code,
      serviceName: targetService.name,
      revenueHead: revenueHead || targetService.revenueHead,
      chargeDescription,
      assessmentItems: formattedItems,
      amountPayable: finalAmount,
      issuedDate: new Date().toISOString(),
      dueDate: finalDueDate,
      noticeStatus: "unpaid",
      notes: notes || null,
      statutoryAccount: {
        bankName: bankDetails.bankName,
        bankCode: bankDetails.bankCode || "000023",
        accountName: bankDetails.accountName,
        accountNumber: bankDetails.accountNumber,
        serviceCode: bankDetails.serviceCode,
      },
      issuedBy: {
        userId: officerId,
        userName: (req as any).user?.firstName
          ? `${(req as any).user.firstName} ${(req as any).user.lastName || ""}`
          : "Authorized Revenue Officer",
        role: (req as any).user?.role || "revenue_officer",
      },
    };

    // 5. Create Application and linked Invoice in Transaction
    const result = await prisma.$transaction(async (tx) => {
      const applicationNumber = generateReference("IFO-APP");
      const invoiceNumber = generateReference("INV-IFO");

      const app = await tx.application.create({
        data: {
          applicationNumber,
          serviceId: targetService.id,
          feeAmount: finalAmount,
          status: "awaiting_payment_confirmation",
          formData: noticeFormData as any,
          ...(officerId ? { applicantId: officerId, createdById: officerId } : {}),
        },
      });

      const inv = await tx.invoice.create({
        data: {
          invoiceNumber,
          applicationId: app.id,
          serviceId: targetService.id,
          amount: finalAmount,
          paymentStatus: "pending",
          virtualBankName: bankDetails.bankName,
          virtualAccountNumber: bankDetails.accountNumber,
          virtualAccountRef: noticeRef,
          createdById: officerId,
        },
      });

      // Write Audit Log
      await tx.auditLog.create({
        data: {
          action: "invoice_created",
          entity: "DemandNotice",
          entityId: app.id,
          userId: officerId,
          details: {
            action: "demand_notice_issued",
            demandNoticeNumber: noticeRef,
            invoiceNumber,
            payerName,
            amount: finalAmount,
            ward,
            accountNumber: bankDetails.accountNumber,
          } as any,
        },
      });

      return { application: app, invoice: inv };
    });

    // 6. Send Email Notification if email is provided
    if (email && email.includes("@")) {
      try {
        const emailHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; line-height: 1.5;">
            <div style="background-color: #0F4C2A; color: white; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
              <h2 style="margin: 0; font-size: 20px; font-weight: 800; letter-spacing: 0.5px;">IFO LOCAL GOVERNMENT COUNCIL</h2>
              <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">INTERNAL REVENUE SERVICE · STATUTORY DEMAND NOTICE</p>
            </div>
            <div style="background-color: #ffffff; border: 1px solid #e2e8f0; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
              <p>Dear <strong>${payerName}</strong>,</p>
              <p>TAKE NOTICE that a statutory municipal demand notice has been issued to you by the Ifo Local Government Authority under applicable revenue edicts.</p>
              
              <div style="background-color: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; padding: 16px; margin: 16px 0;">
                <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
                  <tr><td style="color: #64748b; padding: 4px 0;">Notice Number:</td><td style="font-weight: bold; font-family: monospace;">${noticeRef}</td></tr>
                  <tr><td style="color: #64748b; padding: 4px 0;">Payer / Entity:</td><td style="font-weight: bold;">${payerName}</td></tr>
                  <tr><td style="color: #64748b; padding: 4px 0;">Ward / Location:</td><td>${ward} — ${address}</td></tr>
                  <tr><td style="color: #64748b; padding: 4px 0;">Revenue Head:</td><td>${revenueHead}</td></tr>
                  <tr><td style="color: #64748b; padding: 4px 0;">Amount Payable:</td><td style="font-weight: 800; color: #0F4C2A; font-size: 16px;">₦${finalAmount.toLocaleString()}</td></tr>
                  <tr><td style="color: #64748b; padding: 4px 0;">Due Date:</td><td style="font-weight: bold; color: #b91c1c;">${new Date(finalDueDate).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</td></tr>
                </table>
              </div>

              <div style="background-color: #ecfdf5; border: 1px solid #6ee7b7; border-radius: 6px; padding: 16px; margin: 16px 0;">
                <h4 style="margin: 0 0 8px; color: #065f46; font-size: 14px;">STATUTORY PAYMENT INSTRUCTIONS (PROVIDUS BANK)</h4>
                <p style="margin: 0 0 8px; font-size: 12px; color: #047857;">Please transfer directly to your service's dedicated Providus Bank account below:</p>
                <table style="width: 100%; font-size: 13px; font-family: monospace;">
                  <tr><td style="color: #065f46;">Bank Name:</td><td style="font-weight: bold;">${bankDetails.bankName}</td></tr>
                  <tr><td style="color: #065f46;">Account Name:</td><td style="font-weight: bold;">${bankDetails.accountName}</td></tr>
                  <tr><td style="color: #065f46;">Account Number:</td><td style="font-weight: 800; font-size: 16px; color: #0F4C2A;">${bankDetails.accountNumber}</td></tr>
                </table>
                <p style="margin: 8px 0 0; font-size: 11px; color: #065f46;"><em>Quote Notice Number <strong>${noticeRef}</strong> as transaction narration. Verification is automated upon transfer.</em></p>
              </div>

              <p style="font-size: 12px; color: #64748b; margin-top: 20px;">
                You may also inspect your demand notice and pay online at: <br/>
                <a href="${PORTAL_URL}/demand-notice/${encodeURIComponent(noticeRef)}" style="color: #0F4C2A; font-weight: bold;">
                  ${PORTAL_URL}/demand-notice/${encodeURIComponent(noticeRef)}
                </a>
              </p>
            </div>
          </div>
        `;
        await sendEmail({
          to: email,
          subject: `Statutory Demand Notice: ${noticeRef} — Ifo Local Government`,
          html: emailHtml,
        });
      } catch (mailErr) {
        console.warn("[demandNotice] Failed to send notice email notification:", mailErr);
      }
    }

    return sendSuccess(
      res,
      {
        demandNoticeNumber: noticeRef,
        applicationId: result.application.id,
        invoiceId: result.invoice.id,
        invoiceNumber: result.invoice.invoiceNumber,
        amountPayable: finalAmount,
        dueDate: finalDueDate,
        statutoryAccount: noticeFormData.statutoryAccount,
        notice: noticeFormData,
      },
      "Demand notice issued successfully",
      201
    );
  } catch (err) {
    next(err);
  }
};

/**
 * 2. LIST AND FILTER DEMAND NOTICES
 * GET /api/v1/demand-notices
 */
export const listDemandNotices = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const {
      status = "all", // "all" | "paid" | "unpaid" | "overdue" | "cancelled"
      search = "",
      ward,
      startDate,
      endDate,
      page = "1",
      limit = "25",
    } = req.query;

    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 25));
    const skip = (pageNum - 1) * limitNum;

    // Build Prisma query condition
    const where: any = {
      formData: {
        path: ["demandNoticeNumber"],
        not: null as any,
      },
    };

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(String(startDate));
      if (endDate) where.createdAt.lte = new Date(String(endDate));
    }

    // Fetch notices with invoice, payments, and receipts
    const applications = await prisma.application.findMany({
      where,
      include: {
        invoice: {
          include: {
            receipts: true,
            payments: {
              orderBy: { createdAt: "desc" },
              take: 1,
            },
          },
        },
        service: {
          select: { id: true, code: true, name: true, revenueHead: true },
        },
        createdBy: {
          select: { id: true, firstName: true, lastName: true, role: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const now = new Date();

    // Map and compute status
    let mapped = applications.map((app) => {
      const data = (app.formData || {}) as Record<string, any>;
      const inv = app.invoice;
      const isPaid = inv?.paymentStatus === "confirmed";
      const isCancelled = app.status === "cancelled" || data.noticeStatus === "cancelled";
      const dueDate = data.dueDate ? new Date(data.dueDate) : null;
      const isOverdue = !isPaid && !isCancelled && dueDate ? dueDate < now : false;

      let computedStatus: "paid" | "unpaid" | "overdue" | "cancelled" = "unpaid";
      if (isCancelled) computedStatus = "cancelled";
      else if (isPaid) computedStatus = "paid";
      else if (isOverdue) computedStatus = "overdue";
      else computedStatus = "unpaid";

      const amount = Number(inv?.amount || data.amountPayable || 0);

      return {
        id: app.id,
        applicationNumber: app.applicationNumber,
        demandNoticeNumber: data.demandNoticeNumber || app.applicationNumber,
        payerType: data.payerType || "business",
        payerName: data.payerName || data.fullName || "Liable Entity",
        tradingName: data.tradingName || null,
        phone: data.phone || "",
        email: data.email || null,
        ward: data.ward || "",
        address: data.address || "",
        serviceName: data.serviceName || app.service?.name || "Demand Notice",
        revenueHead: data.revenueHead || app.service?.revenueHead || "2002 - Demand Notices",
        chargeDescription: data.chargeDescription || "",
        assessmentItems: data.assessmentItems || [],
        amountPayable: amount,
        issuedDate: data.issuedDate || app.createdAt.toISOString(),
        dueDate: data.dueDate || null,
        status: computedStatus,
        paymentStatus: inv?.paymentStatus || "pending",
        invoiceNumber: inv?.invoiceNumber || null,
        invoiceId: inv?.id || null,
        statutoryAccount: data.statutoryAccount || resolveServiceProvidusAccount(app.service?.code || "demand_notice"),
        receiptNumber: inv?.receipts?.[0]?.receiptNumber || null,
        receiptId: inv?.receipts?.[0]?.id || null,
        paidAt: inv?.paidAt || null,
        issuedBy: app.createdBy
          ? `${app.createdBy.firstName} ${app.createdBy.lastName || ""}`
          : "Revenue Office",
        createdAt: app.createdAt.toISOString(),
      };
    });

    if (ward && String(ward) !== "all") {
      const wardStr = String(ward).toLowerCase();
      mapped = mapped.filter((m) => m.ward.toLowerCase().includes(wardStr));
    }

    // Compute Global Metrics
    const metrics = {
      totalIssued: mapped.length,
      totalPaid: mapped.filter((m) => m.status === "paid").length,
      totalUnpaid: mapped.filter((m) => m.status === "unpaid").length,
      totalOverdue: mapped.filter((m) => m.status === "overdue").length,
      totalCancelled: mapped.filter((m) => m.status === "cancelled").length,
      totalAmountAssessed: mapped.reduce((sum, m) => sum + (m.status !== "cancelled" ? m.amountPayable : 0), 0),
      totalAmountCollected: mapped.reduce((sum, m) => sum + (m.status === "paid" ? m.amountPayable : 0), 0),
    };

    // Apply client-side filters (status & search)
    if (status && status !== "all") {
      mapped = mapped.filter((m) => m.status === status);
    }

    if (search && String(search).trim()) {
      const q = String(search).toLowerCase().trim();
      mapped = mapped.filter(
        (m) =>
          m.demandNoticeNumber.toLowerCase().includes(q) ||
          m.payerName.toLowerCase().includes(q) ||
          m.phone.toLowerCase().includes(q) ||
          m.address.toLowerCase().includes(q) ||
          m.ward.toLowerCase().includes(q)
      );
    }

    const filteredTotal = mapped.length;
    const paginated = mapped.slice(skip, skip + limitNum);

    return sendSuccess(
      res,
      {
        notices: paginated,
        metrics,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: filteredTotal,
          totalPages: Math.ceil(filteredTotal / limitNum),
        },
      },
      "Demand notices retrieved successfully"
    );
  } catch (err) {
    next(err);
  }
};

/**
 * 3. GET SINGLE DEMAND NOTICE BY REFERENCE NUMBER
 * GET /api/v1/demand-notices/:reference (Public / Authorized)
 */
export const getDemandNoticeByRef = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const rawRef = decodeURIComponent(String(req.params.reference || "")).trim();
    if (!rawRef) {
      return sendError(res, "Notice reference is required", "VALIDATION_ERROR", null, 400);
    }

    const app = await prisma.application.findFirst({
      where: {
        OR: [
          {
            formData: {
              path: ["demandNoticeNumber"],
              equals: rawRef,
            },
          },
          { applicationNumber: rawRef },
          { id: rawRef },
        ],
      },
      include: {
        invoice: {
          include: {
            receipts: true,
            payments: {
              where: { status: "confirmed" },
              orderBy: { createdAt: "desc" },
            },
          },
        },
        service: true,
        createdBy: {
          select: { id: true, firstName: true, lastName: true, role: true },
        },
      },
    });

    if (!app) {
      return sendError(res, `Demand notice "${rawRef}" not found`, "NOT_FOUND", null, 404);
    }

    const data = (app.formData || {}) as Record<string, any>;
    const inv = app.invoice;
    const isPaid = inv?.paymentStatus === "confirmed";
    const isCancelled = app.status === "cancelled" || data.noticeStatus === "cancelled";
    const dueDate = data.dueDate ? new Date(data.dueDate) : null;
    const isOverdue = !isPaid && !isCancelled && dueDate ? dueDate < new Date() : false;

    let computedStatus: "paid" | "unpaid" | "overdue" | "cancelled" = "unpaid";
    if (isCancelled) computedStatus = "cancelled";
    else if (isPaid) computedStatus = "paid";
    else if (isOverdue) computedStatus = "overdue";
    else computedStatus = "unpaid";

    const bankDetails = data.statutoryAccount || resolveServiceProvidusAccount(app.service?.code || "demand_notice");

    return sendSuccess(res, {
      id: app.id,
      applicationNumber: app.applicationNumber,
      demandNoticeNumber: data.demandNoticeNumber || app.applicationNumber,
      payerType: data.payerType || "business",
      payerName: data.payerName || data.fullName || "Liable Entity",
      tradingName: data.tradingName || null,
      rcNumber: data.rcNumber || null,
      phone: data.phone || "",
      email: data.email || null,
      ward: data.ward || "",
      address: data.address || "",
      serviceName: data.serviceName || app.service?.name || "Demand Notice",
      revenueHead: data.revenueHead || app.service?.revenueHead || "2002 - Demand Notices",
      chargeDescription: data.chargeDescription || "",
      assessmentItems: data.assessmentItems || [],
      amountPayable: Number(inv?.amount || data.amountPayable || 0),
      issuedDate: data.issuedDate || app.createdAt.toISOString(),
      dueDate: data.dueDate || null,
      status: computedStatus,
      paymentStatus: inv?.paymentStatus || "pending",
      invoice: inv
        ? {
            id: inv.id,
            invoiceNumber: inv.invoiceNumber,
            amount: Number(inv.amount),
            paymentStatus: inv.paymentStatus,
            paidAt: inv.paidAt,
          }
        : null,
      statutoryAccount: bankDetails,
      receipt: inv?.receipts?.[0]
        ? {
            id: inv.receipts[0].id,
            receiptNumber: inv.receipts[0].receiptNumber,
            amountPaid: Number(inv.receipts[0].amountPaid),
            paymentDate: inv.receipts[0].issuedAt,
          }
        : null,
      issuedBy: app.createdBy
        ? `${app.createdBy.firstName} ${app.createdBy.lastName || ""}`
        : "Ifo Revenue Service",
      createdAt: app.createdAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * 4. CANCEL A DEMAND NOTICE
 * POST /api/v1/demand-notices/:id/cancel
 */
export const cancelDemandNotice = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = String(req.params.id);
    const { reason = "Administrative cancellation" } = req.body;
    const officerId = (req as any).user?.id;

    const app = await prisma.application.findUnique({
      where: { id },
      include: { invoice: true },
    });

    if (!app) {
      return sendError(res, "Demand notice not found", "NOT_FOUND", null, 404);
    }

    const currentData = (app.formData || {}) as Record<string, any>;
    const inv = app.invoice;
    if (inv?.paymentStatus === "confirmed") {
      return sendError(
        res,
        "Cannot cancel an already settled/paid demand notice",
        "BAD_REQUEST",
        null,
        400
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.application.update({
        where: { id },
        data: {
          status: "cancelled",
          formData: {
            ...currentData,
            noticeStatus: "cancelled",
            cancellationReason: reason,
            cancelledAt: new Date().toISOString(),
            cancelledById: officerId,
          },
        },
      });

      if (inv) {
        await tx.invoice.update({
          where: { id: inv.id },
          data: { paymentStatus: "cancelled" as any },
        });
      }

      await tx.auditLog.create({
        data: {
          action: "invoice_cancelled",
          entity: "DemandNotice",
          entityId: id,
          userId: officerId,
          details: {
            reason,
            demandNoticeNumber: currentData.demandNoticeNumber,
          } as any,
        },
      });
    });

    return sendSuccess(res, null, "Demand notice cancelled successfully");
  } catch (err) {
    next(err);
  }
};

/**
 * 5. RESEND DEMAND NOTICE NOTIFICATION
 * POST /api/v1/demand-notices/:id/resend
 */
export const resendDemandNotice = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const id = String(req.params.id);
    const { email: overrideEmail } = req.body;

    const app = await prisma.application.findUnique({
      where: { id },
      include: { invoice: true },
    });

    if (!app) {
      return sendError(res, "Demand notice not found", "NOT_FOUND", null, 404);
    }

    const data = (app.formData || {}) as Record<string, any>;
    const targetEmail = overrideEmail || data.email;
    if (!targetEmail || !targetEmail.includes("@")) {
      return sendError(res, "No valid email address found for this notice", "VALIDATION_ERROR", null, 400);
    }

    const noticeRef = data.demandNoticeNumber || app.applicationNumber;
    const bankDetails = data.statutoryAccount || resolveServiceProvidusAccount(data.serviceCode || "demand_notice");

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; line-height: 1.5;">
        <div style="background-color: #0F4C2A; color: white; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0; font-size: 20px; font-weight: 800;">IFO LOCAL GOVERNMENT COUNCIL</h2>
          <p style="margin: 4px 0 0; font-size: 13px;">OFFICIAL STATUTORY DEMAND NOTICE (REMINDER)</p>
        </div>
        <div style="background-color: #ffffff; border: 1px solid #e2e8f0; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <p>Dear <strong>${data.payerName}</strong>,</p>
          <p>This is a notification reminder regarding statutory demand notice <strong>${noticeRef}</strong> issued to your entity by Ifo Local Government.</p>
          
          <div style="background-color: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; padding: 16px; margin: 16px 0;">
            <table style="width: 100%; font-size: 13px;">
              <tr><td style="color: #64748b; padding: 4px 0;">Notice Ref:</td><td style="font-weight: bold; font-family: monospace;">${noticeRef}</td></tr>
              <tr><td style="color: #64748b; padding: 4px 0;">Amount Due:</td><td style="font-weight: 800; color: #0F4C2A; font-size: 16px;">₦${Number(data.amountPayable || 0).toLocaleString()}</td></tr>
              <tr><td style="color: #64748b; padding: 4px 0;">Due Date:</td><td style="font-weight: bold; color: #b91c1c;">${data.dueDate ? new Date(data.dueDate).toLocaleDateString("en-GB") : "14 Days"}</td></tr>
            </table>
          </div>

          <div style="background-color: #ecfdf5; border: 1px solid #6ee7b7; border-radius: 6px; padding: 16px; margin: 16px 0;">
            <h4 style="margin: 0 0 8px; color: #065f46; font-size: 14px;">DESIGNATED PROVIDUS BANK PAYMENT ACCOUNT</h4>
            <table style="width: 100%; font-size: 13px; font-family: monospace;">
              <tr><td style="color: #065f46;">Bank Name:</td><td style="font-weight: bold;">${bankDetails.bankName}</td></tr>
              <tr><td style="color: #065f46;">Account Name:</td><td style="font-weight: bold;">${bankDetails.accountName}</td></tr>
              <tr><td style="color: #065f46;">Account Number:</td><td style="font-weight: 800; font-size: 16px; color: #0F4C2A;">${bankDetails.accountNumber}</td></tr>
            </table>
          </div>

          <p style="text-align: center; margin-top: 24px;">
            <a href="${PORTAL_URL}/demand-notice/${encodeURIComponent(noticeRef)}" 
               style="background-color: #0F4C2A; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; display: inline-block;">
              View & Pay Demand Notice
            </a>
          </p>
        </div>
      </div>
    `;

    await sendEmail({
      to: targetEmail,
      subject: `[REMINDER] Statutory Demand Notice: ${noticeRef} — Ifo Local Government`,
      html: emailHtml,
    });

    return sendSuccess(res, null, `Demand notice sent successfully to ${targetEmail}`);
  } catch (err) {
    next(err);
  }
};
