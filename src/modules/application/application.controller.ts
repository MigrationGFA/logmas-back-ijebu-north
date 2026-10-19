import { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import { sendSuccess, sendError } from "../../utils/response";
import * as ApplicationService from "./application.service";
import { createApplicationSchema } from "./application.validation";
import { prisma } from "../../utils/prisma";
import { notify } from "../notification/notification.service";
import { generateQrToken, generateReceiptNumber, generateVerificationCode } from "../../utils/generators";

export const createApplication = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  let files: multer.File[] | undefined;

  try {
    const user = req.user!;

    files = (req as any).files as multer.File[] | undefined;

    const raw = req.body || {};

    // PATCH /applications/:id/complete = completion mode
    const isCompletion = req.method === "PATCH" && !!req.params.id;

    const applicationId = isCompletion ? String(req.params.id) : undefined;

    // ------------------------------------------------------------
    // Parse multipart form data
    // ------------------------------------------------------------

    if ("feeAmount" in raw) {
      delete raw.feeAmount;
    }

    let parsedFormData: any = raw.formData ?? {};

    if (typeof parsedFormData === "string" && parsedFormData.length > 0) {
      try {
        parsedFormData = JSON.parse(parsedFormData);
      } catch {
        return sendError(
          res,
          "Invalid formData JSON",
          "VALIDATION_ERROR",
          null,
          400,
        );
      }
    }

    const payload = {
      serviceId: raw.serviceId,
      applicantId: raw.applicantId,
      formData: parsedFormData,
    };

    const validation = createApplicationSchema.safeParse(payload);

    if (!validation.success) {
      if (files?.length) {
        for (const file of files) {
          try {
            fs.unlinkSync(path.resolve(file.path));
          } catch {}
        }
      }

      return sendError(
        res,
        "Data validation processing failed",
        "VALIDATION_ERROR",
        validation.error.format(),
        400,
      );
    }

    // ------------------------------------------------------------
    // Prepare files
    // ------------------------------------------------------------

    const serverUrl = `${req.protocol}://${req.get("host")}`;

    const filesMeta = (files || []).map((file) => {
      const normalizedRelativePath = file.path.replace(/\\/g, "/");

      return {
        originalName: file.originalname,
        fileName: file.filename,
        relativePath: normalizedRelativePath,
        url: `${serverUrl}/${normalizedRelativePath}`,
        documentType: file.fieldname,
      } as any;
    });

    // ------------------------------------------------------------
    // Validate uploaded documents
    // ------------------------------------------------------------

    if (files?.length) {
      const seen = new Set<string>();

      for (const file of files) {
        const documentType = file.fieldname;

        if (seen.has(documentType)) {
          return sendError(
            res,
            `Duplicate document type uploaded: ${documentType}`,
            "VALIDATION_ERROR",
            null,
            400,
          );
        }

        seen.add(documentType);
      }

      const service = await prisma.service.findUnique({
        where: {
          id: validation.data.serviceId,
        },
        select: {
          id: true,
          isActive: true,
          requirements: true,
        },
      });

      if (!service) {
        return sendError(res, "Service not found", "NOT_FOUND", null, 404);
      }

      if (!service.isActive) {
        return sendError(
          res,
          "Service is not active",
          "BAD_REQUEST",
          null,
          400,
        );
      }

      if (
        Array.isArray(service.requirements) &&
        service.requirements.length > 0
      ) {
        const missing = service.requirements.filter(
          (requiredDocument: string) => !seen.has(requiredDocument),
        );

        if (missing.length > 0) {
          return sendError(
            res,
            `Missing required documents: ${missing.join(", ")}`,
            "VALIDATION_ERROR",
            null,
            400,
          );
        }

        const invalid = Array.from(seen).filter(
          (documentType) => !service.requirements.includes(documentType),
        );

        if (invalid.length > 0) {
          return sendError(
            res,
            `Invalid document types for this service: ${invalid.join(", ")}`,
            "VALIDATION_ERROR",
            null,
            400,
          );
        }
      }
    }

    // ------------------------------------------------------------
    // COMPLETE EXISTING APPLICATION
    // ------------------------------------------------------------

    if (isCompletion) {
      const existingApplication = await prisma.application.findUnique({
        where: {
          id: applicationId!,
        },
        select: {
          id: true,
          applicantId: true,
          serviceId: true,
          paymentFirst: true,
          status: true,
        },
      });

      if (!existingApplication) {
        return sendError(res, "Application not found", "NOT_FOUND", null, 404);
      }

      // Applicant must own the application.
      if (
        existingApplication.applicantId &&
        existingApplication.applicantId !== user.id
      ) {
        return sendError(
          res,
          "You are not allowed to complete this application",
          "FORBIDDEN",
          null,
          403,
        );
      }

      // Frontend must use the same service.
      if (existingApplication.serviceId !== validation.data.serviceId) {
        return sendError(
          res,
          "The selected service does not match this application",
          "VALIDATION_ERROR",
          null,
          400,
        );
      }

      const result = await ApplicationService.createOrUpdateApplication({
        mode: "complete",
        applicationId: applicationId!,
        applicantId: existingApplication.applicantId ?? undefined,
        serviceId: validation.data.serviceId,
        formData: validation.data.formData,
        files: filesMeta,
        createInvoice: false,
      });

      const application = result.application;

      // ----------------------------------------------------------
      // Notification
      // ----------------------------------------------------------

      // if (application?.applicant) {
      //   try {
      //     const fullName = `${application.applicant.firstName} ${application.applicant.lastName}`;

      //     await notify({
      //       userId: application.applicantId,
      //       to: {
      //         email: application.applicant.email,
      //         phone: application.applicant.phone ?? "",
      //       },
      //       templateKey: "application.applicationCompleteYourForm",
      //       vars: {
      //         applicant_name: fullName,
      //         application_number: application.applicationNumber,
      //         service_name: application.service.name,
      //         application_id: application.id,
      //         fee_amount: application.feeAmount.toString(),
      //       },
      //       channels: ["email", "sms"],
      //     });
      //   } catch (notifyErr) {
      //     console.error(
      //       "[completeApplication] notify() failed, continuing:",
      //       notifyErr,
      //     );
      //   }
      // }

      return sendSuccess(res, result, null, 200);
    }

    // ============================================================
    // NORMAL CREATE APPLICATION
    // ============================================================

    const actorRole = user.role;

    let applicantIdToUse: string | null = null;
    let createdById: string = user.id;

    if (actorRole === "citizen" || actorRole === "business_owner") {
      if (raw.applicantId && raw.applicantId !== user.id) {
        return sendError(
          res,
          "You cannot submit an application on behalf of another applicant",
          "FORBIDDEN",
          null,
          403,
        );
      }

      applicantIdToUse = user.id;
      createdById = user.id;
    } else if (actorRole === "field_officer") {
      if (raw.applicantId) {
        const target = await prisma.user.findUnique({
          where: {
            id: String(raw.applicantId),
          },
          select: {
            id: true,
            role: true,
          },
        });

        if (!target) {
          return sendError(
            res,
            "Supplied applicantId not found",
            "NOT_FOUND",
            null,
            404,
          );
        }

        if (target.role !== "citizen" && target.role !== "business_owner") {
          return sendError(
            res,
            "Field officers may only create applications for citizens or business owners",
            "VALIDATION_ERROR",
            null,
            400,
          );
        }

        applicantIdToUse = target.id;
      }

      createdById = user.id;
    } else {
      return sendError(
        res,
        "You are not allowed to create applications",
        "FORBIDDEN",
        null,
        403,
      );
    }

    // ------------------------------------------------------------
    // CREATE
    // ------------------------------------------------------------

    const result = await ApplicationService.createOrUpdateApplication({
      mode: "create",
      applicantId: applicantIdToUse ?? undefined,
      createdById,
      serviceId: validation.data.serviceId,
      formData: validation.data.formData,
      files: filesMeta,
      createInvoice: true,
    });

    const application = result.application;

    if (application?.applicant) {
      try {
        const fullName = `${application.applicant.firstName} ${application.applicant.lastName}`;

        await notify({
          userId: application.applicantId,
          to: {
            email: application.applicant.email,
            phone: application.applicant.phone ?? "",
          },
          templateKey: "application.applicationSubmitted",
          vars: {
            applicant_name: fullName,
            application_number: application.applicationNumber,
            service_name: application.service.name,
            application_id: application.id,
            fee_amount: application.feeAmount.toString(),
          },
          channels: ["email", "sms"],
        });
      } catch (notifyErr) {
        console.error(
          "[createApplication] notify() failed, continuing:",
          notifyErr,
        );
      }
    }

    return sendSuccess(res, result, null, 201);
  } catch (err: any) {
    if (files?.length) {
      for (const file of files) {
        try {
          fs.unlinkSync(path.resolve(file.path));
        } catch {}
      }
    }

    return next(err);
  }
};

export const getApplicationById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id } = req.params;
    const app = await ApplicationService.getApplicationByIdOrNumber(String(id));
    if (!app)
      return sendError(res, "Application not found", "NOT_FOUND", null, 404);

    // Authorization: if requester is citizen/business_owner ensure they own it
    const user = req.user!;
    if (
      (user.role === "citizen" || user.role === "business_owner") &&
      app.applicantId !== user.id
    ) {
      return sendError(
        res,
        "You do not have permission to view this application",
        "FORBIDDEN",
        null,
        403,
      );
    }

    return sendSuccess(res, app);
  } catch (err) {
    next(err);
  }
};

export const listApplications = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = req.user!;
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 25;

    const result = await ApplicationService.listApplicationsForUser(
      user,
      page,
      limit,
      req.query,
    );

    return sendSuccess(res, result.items, result.meta);
  } catch (err) {
    next(err);
  }
};

// ── ADMIN (LGA) endpoints ──────────────────────────────────────────────────
export const adminListApplications = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 25;
    const status =
      typeof req.query.status === "string" ? req.query.status : undefined;
    const serviceId =
      typeof req.query.serviceId === "string" ? req.query.serviceId : undefined;
    const search =
      typeof req.query.search === "string" ? req.query.search : undefined;

    const where: any = {};
    if (status) where.status = status;
    if (serviceId) where.serviceId = serviceId;
    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: "insensitive" } },
        { applicationNumber: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.application.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          service: true,
          invoice: true,
          applicationDocuments: true,
          applicant: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
            },
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

export const adminGetApplication = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let { id } = req.params;
    if (Array.isArray(id)) id = id[0];

    const app = await ApplicationService.getApplicationByIdOrNumber(String(id));
    if (!app)
      return sendError(res, "Application not found", "NOT_FOUND", null, 404);

    return sendSuccess(res, app);
  } catch (err) {
    next(err);
  }
};

export const adminSetUnderReview = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let { id } = req.params;
    if (Array.isArray(id)) id = id[0];
    const adminId = req.user!.id;

    const app = await prisma.application.findUnique({
      where: { id: String(id) },
    });
    if (!app)
      return sendError(res, "Application not found", "NOT_FOUND", null, 404);
    if (app.status !== "submitted")
      return sendError(
        res,
        "Only submitted applications can be moved to under_review",
        "BAD_REQUEST",
        null,
        400,
      );

    const updated = await prisma.application.update({
      where: { id: String(id) },
      data: {
        status: "under_review",
        reviewedById: adminId,
        reviewedAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        action: "approval_granted",
        entity: "Application",
        entityId: id,
        userId: adminId,
        details: { action: "under_review" },
        ipAddress: req.ip,
      },
    });

    return sendSuccess(res, updated, "Application moved to under_review");
  } catch (err) {
    next(err);
  }
};

export const adminApproveApplication = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let { id } = req.params;
    if (Array.isArray(id)) id = id[0];
    const adminId = req.user!.id;

    const app = await prisma.application.findUnique({
      where: { id: String(id) },
      include: {
        applicant: true,
        service: true,
        invoice: true,
        certificate: true,
      },
    });
    if (!app)
      return sendError(res, "Application not found", "NOT_FOUND", null, 404);
    if (app.status !== "under_review")
      return sendError(
        res,
        "Only applications under review can be approved",
        "BAD_REQUEST",
        null,
        400,
      );

      const result = await prisma.$transaction(async (tx) => {

    const updated = await tx.application.update({
      where: { id: String(id) },
      data: {
        status: "approved",
        reviewedById: adminId,
        reviewedAt: new Date(),
      },
      include: {
        reviewedBy: true,
      },
    });

    const certificate = await tx.certificate.create({
        data: {
          application: {
            connect: { id: String(id) },
          },
          certificateNumber: generateReceiptNumber('CERT'),
          verificationCode: generateVerificationCode(),
          qrToken: generateQrToken(),
          issuedAt: new Date(),
          issuedBy: {
            connect: { id: adminId },
          },
          // expiresAt — optional, set if needed
        },
      });

          return {  updated, certificate };
    });


    await prisma.auditLog.create({
      data: {
        action: "approval_granted",
        entity: "Application",
        entityId: id,
        userId: adminId,
        details: { action: "approved" },
        ipAddress: req.ip,
      },
    });


    try {
      const fullName = `${app.applicant.firstName} ${app.applicant.lastName}`;
      await notify({
        userId: app.applicant.id,
        to: {
          email: app.applicant.email,
          phone: app.applicant.phone ?? "",
        },
        templateKey: "application.applicationApproved",
        vars: {
          applicant_name: fullName,
          application_number: app.applicationNumber,
          service_name: app.service.name,
          application_id: app.id,
          reviewer_name: result.updated.reviewedById
            ? `${result.updated.reviewedBy.firstName} ${result.updated.reviewedBy.lastName}`
            : "Admin",
          reviewed_at: new Date().toLocaleDateString(),
          fee_amount: app.feeAmount.toString(),
          invoice_number: app.invoice.invoiceNumber,
          invoice_amount: app.invoice.amount.toString(),
          invoice_status: app.invoice.paymentStatus,
          certificate_number: result.certificate?.certificateNumber,
          verification_code: result.certificate?.verificationCode,
        },
        channels: ["email", "sms"],
      });
    } catch (notifyErr) {
      console.error(
        "[resetAccountPassword] notify() failed, continuing anyway:",
        notifyErr,
      );
    }

    return sendSuccess(res, result.updated, "Application approved");
  } catch (err) {
    next(err);
  }
};

export const adminDeclineApplication = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let { id } = req.params;
    if (Array.isArray(id)) id = id[0];
    const adminId = req.user!.id;
    const { declineReason } = req.body;

    if (
      !declineReason ||
      (typeof declineReason === "string" && declineReason.trim().length === 0)
    ) {
      return sendError(
        res,
        "declineReason is required when declining an application",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }

    const app = await prisma.application.findUnique({
      where: { id: String(id) },
      include: {
        applicant: true,
        service: true,
        invoice: true,
      },
    });
    if (!app)
      return sendError(res, "Application not found", "NOT_FOUND", null, 404);
    if (app.status !== "under_review")
      return sendError(
        res,
        "Only applications under review can be declined",
        "BAD_REQUEST",
        null,
        400,
      );

    const updated = await prisma.application.update({
      where: { id: String(id) },
      data: {
        status: "declined",
        reviewedById: adminId,
        reviewedAt: new Date(),
        declineReason,
      },
      include: {
        reviewedBy: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        action: "application_rejected",
        entity: "Application",
        entityId: id,
        userId: adminId,
        details: { declineReason },
        ipAddress: req.ip,
      },
    });

    try {
      const fullName = `${app.applicant.firstName} ${app.applicant.lastName}`;
      await notify({
        userId: app.applicant.id,
        to: {
          email: app.applicant.email,
          phone: app.applicant.phone ?? "",
        },
        templateKey: "application.applicationDeclined",
        vars: {
          applicant_name: fullName,
          application_number: app.applicationNumber,
          service_name: app.service.name,
          application_id: app.id,
          service_id: app.serviceId,
          reviewed_at: new Date().toISOString(),
          reviewer_name: updated.reviewedById
            ? `${updated.reviewedBy.firstName} ${updated.reviewedBy.lastName}`
            : "Admin",
          decline_reason: declineReason,
        },
        channels: ["email", "sms"],
      });
    } catch (notifyErr) {
      console.error(
        "[adminDeclineApplication] notify() failed, continuing anyway:",
        notifyErr,
      );
    }

    return sendSuccess(res, updated, "Application declined");
  } catch (err) {
    next(err);
  }
};

/**
 * GET /applications/reference/:reference  — PUBLIC (no requireAuth by design)
 *
 * Backs the citizen "Track My Application" page in the frontend. Accepts:
 *   - application number, e.g. "ODE-APP-2026-000101" (case-insensitive)
 *   - application UUID
 *   - invoice number / transaction reference / virtual account reference
 *
 * Returns a deliberately REDACTED projection: only the applicant's name
 * fields are exposed from formData (no email, phone or address), and no
 * payment gateway references — anyone holding an application number can
 * call this route.
 */
export const getApplicationByReference = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const rawRef = req.params.reference;
    const ref = String(Array.isArray(rawRef) ? rawRef[0] : rawRef || "").trim();
    if (!ref) {
      return sendError(
        res,
        "An application reference is required",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }

    const include = {
      service: { select: { id: true, name: true } },
      applicant: { select: { firstName: true, lastName: true } },
      certificate: { select: { certificateNumber: true, issuedAt: true } },
      invoice: {
        include: {
          receipts: { select: { receiptNumber: true, issuedAt: true } },
        },
      },
    };

    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // 1) Exact application number  2) Case-insensitive number  3) UUID id
    let app =
      (await prisma.application.findUnique({
        where: { applicationNumber: ref },
        include,
      })) ??
      (await prisma.application.findFirst({
        where: { applicationNumber: { equals: ref, mode: "insensitive" } },
        include,
      })) ??
      (UUID_RE.test(ref)
        ? await prisma.application.findUnique({ where: { id: ref }, include })
        : null);

    // 4) Payment references → application
    if (!app) {
      const invoice = await prisma.invoice.findFirst({
        where: {
          OR: [
            { invoiceNumber: { equals: ref, mode: "insensitive" } },
            { transactionRef: ref },
            { virtualAccountRef: ref },
          ],
        },
      });
      if (invoice?.applicationId) {
        app = await prisma.application.findUnique({
          where: { id: invoice.applicationId },
          include,
        });
      }
    }

    if (!app) {
      return sendError(
        res,
        `No application found for "${ref}"`,
        "NOT_FOUND",
        null,
        404,
      );
    }

    // ---- Redacted public projection -------------------------------------
    const formData: any = app.formData ?? {};
    const composedName = [formData.firstName, formData.lastName]
      .filter(Boolean)
      .join(" ");
    const applicantName =
      composedName ||
      formData.fullName ||
      (app.applicant
        ? `${app.applicant.firstName} ${app.applicant.lastName}`
        : null);

    const invoice: any = app.invoice ?? null;
    const receipt = invoice?.receipts?.[0] ?? null;
    const paymentStatus: string | null = invoice?.paymentStatus ?? null;

    // History events — only facts provable from the record (the frontend
    // renders timeline entries shaped { id, title, timestamp, description? }).
    const iso = (d: any) => new Date(d).toISOString();
    const timeline: Array<{
      id: string;
      title: string;
      timestamp: string;
      description?: string;
    }> = [
      {
        id: "submitted",
        title: "Application submitted",
        timestamp: iso(app.createdAt),
      },
    ];
    if (invoice) {
      timeline.push({
        id: "invoice",
        title: "Invoice issued",
        timestamp: iso(invoice.createdAt ?? app.createdAt),
        description: invoice.invoiceNumber,
      });
    }
    if (invoice?.paidAt && paymentStatus === "confirmed") {
      timeline.push({
        id: "payment",
        title: "Payment confirmed",
        timestamp: iso(invoice.paidAt),
      });
    }
    if (receipt) {
      timeline.push({
        id: "receipt",
        title: "Receipt issued",
        timestamp: iso(receipt.issuedAt),
        description: receipt.receiptNumber,
      });
    }
    if (app.status === "under_review") {
      timeline.push({
        id: "review",
        title: "Under review by LGA",
        timestamp: iso(app.updatedAt),
      });
    }
    if (app.reviewedAt) {
      timeline.push({
        id: "decision",
        title:
          app.status === "declined"
            ? "Application declined"
            : app.status === "approved"
              ? "Application approved"
              : "Review completed",
        timestamp: iso(app.reviewedAt),
        description: app.declineReason ?? undefined,
      });
    }
    if (app.certificate) {
      timeline.push({
        id: "certificate",
        title: "Certificate issued",
        timestamp: iso(app.certificate.issuedAt),
        description: app.certificate.certificateNumber,
      });
    }
    timeline.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    return sendSuccess(
      res,
      {
        id: app.id,
        applicationNumber: app.applicationNumber,
        status: app.status,
        serviceId: app.serviceId,
        service: app.service,
        serviceName: app.service?.name ?? null,
        applicant: applicantName ? { name: applicantName } : null,
        // Name fields only — contact details and address are never exposed.
        formData: {
          fullName: formData.fullName ?? null,
          firstName: formData.firstName ?? null,
          lastName: formData.lastName ?? null,
        },
        feeAmount: app.feeAmount,
        // The frontend checks top-level "paid"; map confirmed → paid.
        paymentStatus: paymentStatus === "confirmed" ? "paid" : paymentStatus,
        invoiceNumber: invoice?.invoiceNumber ?? null,
        receiptNumber: receipt?.receiptNumber ?? null,
        certificateNumber: app.certificate?.certificateNumber ?? null,
        invoice: invoice
          ? {
              invoiceNumber: invoice.invoiceNumber,
              paymentStatus: invoice.paymentStatus,
              amount: invoice.amount,
              paidAt: invoice.paidAt ?? null,
            }
          : null,
        declineReason: app.declineReason ?? null,
        createdAt: app.createdAt,
        updatedAt: app.updatedAt,
        reviewedAt: app.reviewedAt ?? null,
        timeline,
      },
      "Application found",
    );
  } catch (err) {
    next(err);
  }
};
