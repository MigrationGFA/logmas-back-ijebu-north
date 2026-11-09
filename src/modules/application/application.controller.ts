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

      // Allow all valid JPG/PNG/PDF supporting documents uploaded by the form
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
    } else if (["field_officer", "lga_admin", "super_admin", "contractor"].includes(actorRole)) {
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

        applicantIdToUse = target.id;
      } else {
        applicantIdToUse = user.id;
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

// â”€â”€ ADMIN (LGA) endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    if (!["submitted", "correction_requested", "awaiting_payment_confirmation"].includes(app.status))
      return sendError(
        res,
        "Only submitted or resubmitted applications can be moved to under_review",
        "BAD_REQUEST",
        null,
        400,
      );

    try {
      await (prisma as any).marriageRecord.updateMany({
        where: { applicationId: String(id) },
        data: {
          holgaApprovalStatus: "under_review",
        },
      });
    } catch {}

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
        marriageRecord: true,
      },
    });
    if (!app)
      return sendError(res, "Application not found", "NOT_FOUND", null, 404);
    if (!["under_review", "submitted"].includes(app.status))
      return sendError(
        res,
        "Only submitted or under-review applications can be approved",
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

    if (app.service.code === "marriage_certificate" || app.marriageRecord) {
        await (tx as any).marriageRecord.upsert({
          where: { applicationId: String(id) },
          update: {
            holgaApprovalStatus: "approved",
            holgaApprovedById: adminId,
            holgaApprovedAt: new Date(),
            holgaComments: req.body?.comments || "Approved by Head of Local Government Administration (HOLGA)",
          },
          create: {
            applicationId: String(id),
            holgaApprovalStatus: "approved",
            holgaApprovedById: adminId,
            holgaApprovedAt: new Date(),
            holgaComments: req.body?.comments || "Approved by Head of Local Government Administration (HOLGA)",
            groomFullName: (app.formData as any)?.groomFullName || "Groom",
            groomOccupation: (app.formData as any)?.groomOccupation || "Private Sector",
            groomAge: Number((app.formData as any)?.groomAge) || 25,
            groomAddress: (app.formData as any)?.groomAddress || "",
            groomPhone: (app.formData as any)?.groomPhone || "",
            groomFatherName: (app.formData as any)?.groomFatherName || "Father of Groom",
            groomFatherOccupation: (app.formData as any)?.groomFatherOccupation || "Self Employed",
            brideFullName: (app.formData as any)?.brideFullName || "Bride",
            brideOccupation: (app.formData as any)?.brideOccupation || "Private Sector",
            brideAge: Number((app.formData as any)?.brideAge) || 23,
            brideAddress: (app.formData as any)?.brideAddress || "",
            bridePhone: (app.formData as any)?.bridePhone || "",
            brideFatherName: (app.formData as any)?.brideFatherName || "Father of Bride",
            brideFatherOccupation: (app.formData as any)?.brideFatherOccupation || "Self Employed",
            weddingDate: (app.formData as any)?.weddingDate ? new Date((app.formData as any).weddingDate) : new Date(),
            witness1Name: (app.formData as any)?.witness1Name || "Witness 1",
            witness1Address: (app.formData as any)?.witness1Address || "",
            witness1Phone: (app.formData as any)?.witness1Phone || "",
            witness2Name: (app.formData as any)?.witness2Name || "Witness 2",
            witness2Address: (app.formData as any)?.witness2Address || "",
            witness2Phone: (app.formData as any)?.witness2Phone || "",
          },
        });
      }

      let certificate = null;
      const isMarriageRegistration =
        app.service.code === "marriage_certificate" ||
        app.service.code === "marriage_registration";

      // Statutory requirement: Marriage Registration does NOT issue an online certificate.
      // Physical statutory certificate must be celebrated and collected at the LGA Marriage Registry Secretariat.
      if (!isMarriageRegistration) {
        const certPrefix = "CERT";
        certificate = await tx.certificate.create({
          data: {
            application: {
              connect: { id: String(id) },
            },
            certificateNumber: generateReceiptNumber(certPrefix),
            verificationCode: generateVerificationCode(),
            qrToken: generateQrToken(),
            issuedAt: new Date(),
            issuedBy: {
              connect: { id: adminId },
            },
            // expiresAt — optional, set if needed
          },
        });
      }

      return { updated, certificate };
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
    if (!["under_review", "submitted", "correction_requested"].includes(app.status))
      return sendError(
        res,
        "Only submitted or under-review applications can be declined",
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
 * GET /applications/reference/:reference  â€” PUBLIC (no requireAuth by design)
 *
 * Backs the citizen "Track My Application" page in the frontend. Accepts:
 *   - application number, e.g. "IFO-APP-2026-000101" (case-insensitive)
 *   - application UUID
 *   - invoice number / transaction reference / virtual account reference
 *
 * Returns a deliberately REDACTED projection: only the applicant's name
 * fields are exposed from formData (no email, phone or address), and no
 * payment gateway references â€” anyone holding an application number can
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

    // 4) Payment references â†’ application
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

    // History events â€” only facts provable from the record (the frontend
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
        // Name fields only â€” contact details and address are never exposed.
        formData: {
          fullName: formData.fullName ?? null,
          firstName: formData.firstName ?? null,
          lastName: formData.lastName ?? null,
        },
        feeAmount: app.feeAmount,
        // The frontend checks top-level "paid"; map confirmed â†’ paid.
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


/**
 * PATCH /api/v1/applications/admin/:id/sub-admin-review
 * Sub-Admin First-Level Review across all 17 LOGMAS services:
 * - action: "approve" -> moves application to "under_review" and forwards to Principal Officer / Final Approver (HOLGA)
 * - action: "request_correction" -> moves application to "correction_requested" with comment, notifies applicant to upload correction and resubmit
 * - action: "reject" -> moves application to "declined" with reason
 */
export const subAdminReviewApplication = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let { id } = req.params;
    if (Array.isArray(id)) id = id[0];
    const reviewerId = req.user!.id;
    const { action, comment, reason } = req.body || {};
    const reviewNote = String(comment || reason || "").trim();

    if (!["approve", "request_correction", "reject"].includes(action)) {
      return sendError(
        res,
        "action must be one of: 'approve', 'request_correction', or 'reject'",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }

    if ((action === "request_correction" || action === "reject") && !reviewNote) {
      return sendError(
        res,
        "A comment or reason is required when requesting a correction or rejecting an application",
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

    if (!app) {
      return sendError(res, "Application not found", "NOT_FOUND", null, 404);
    }

    const reviewer = await prisma.user.findUnique({
      where: { id: reviewerId },
      select: { id: true, firstName: true, lastName: true, role: true },
    });
    const reviewerName = reviewer ? `${reviewer.firstName} ${reviewer.lastName}` : "Sub-Admin";

    const existingFd = (app.formData && typeof app.formData === "object")
      ? (app.formData as Record<string, any>)
      : {};
    const history = Array.isArray(existingFd.subAdminReviewHistory)
      ? existingFd.subAdminReviewHistory
      : [];

    const reviewEntry = {
      action,
      status:
        action === "approve"
          ? "approved_for_final_review"
          : action === "request_correction"
            ? "correction_requested"
            : "rejected",
      reviewedById: reviewerId,
      reviewerName,
      reviewerRole: reviewer?.role || "sub_admin",
      reviewedAt: new Date().toISOString(),
      comment:
        reviewNote ||
        "First-level verification completed by Sub-Admin. Forwarded to Principal Officer / HOLGA for final approval.",
    };

    const nextStatus =
      action === "approve"
        ? "under_review"
        : action === "request_correction"
          ? ("correction_requested" as any)
          : "declined";

    const updated = await prisma.application.update({
      where: { id: String(id) },
      data: {
        status: nextStatus,
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        ...(action === "request_correction" || action === "reject"
          ? { declineReason: reviewNote }
          : { declineReason: null }),
        formData: {
          ...existingFd,
          subAdminReview: reviewEntry,
          subAdminReviewHistory: [...history, reviewEntry],
        },
      },
      include: {
        service: true,
        applicant: true,
        applicationDocuments: true,
        invoice: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        action:
          action === "approve"
            ? "approval_granted"
            : action === "request_correction"
              ? "correction_requested"
              : "application_rejected",
        entity: "Application",
        entityId: String(id),
        userId: reviewerId,
        details: {
          stage: "sub_admin_first_review",
          action,
          comment: reviewEntry.comment,
        },
        ipAddress: req.ip,
      },
    });

    // Create in-app notification for applicant when correction is requested or approved
    if (app.applicantId) {
      try {
        await prisma.notification.create({
          data: {
            userId: app.applicantId,
            templateKey: `sub_admin.${action}`,
            title:
              action === "request_correction"
                ? `Correction Requested: ${app.applicationNumber} (${app.service?.name || "Application"})`
                : action === "approve"
                  ? `First-Level Review Passed: ${app.applicationNumber}`
                  : `Application Declined: ${app.applicationNumber}`,
            message:
              action === "request_correction"
                ? `The Sub-Admin has requested a correction or additional document for your ${app.service?.name || "service"} application (${app.applicationNumber}): "${reviewNote}". Please open your application in the portal to upload the corrected document or information and resubmit.`
                : action === "approve"
                  ? `Your application (${app.applicationNumber}) has passed Sub-Admin first-level review and has been forwarded to the Principal Officer for final approval.`
                  : `Your application (${app.applicationNumber}) was declined during review: "${reviewNote}".`,
          },
        });
      } catch {}
    }

    return sendSuccess(
      res,
      updated,
      action === "approve"
        ? "Application approved by Sub-Admin and forwarded to Principal Officer for final approval"
        : action === "request_correction"
          ? "Correction request sent to applicant"
          : "Application declined by Sub-Admin",
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST / PATCH /api/v1/applications/:id/resubmit
 * Allows an applicant (or assisting officer) to upload corrected/additional documents
 * and provide a response note when an application is in "correction_requested" status,
 * returning it to "submitted" for Sub-Admin re-review.
 */
export const applicantResubmitApplication = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let { id } = req.params;
    if (Array.isArray(id)) id = id[0];
    const user = req.user!;
    const files = ((req as any).files as Express.Multer.File[]) || [];
    const { comment, correctionResponse, updatedFields } = req.body || {};

    const app = await prisma.application.findUnique({
      where: { id: String(id) },
      include: { applicationDocuments: true, service: true },
    });

    if (!app) {
      return sendError(res, "Application not found", "NOT_FOUND", null, 404);
    }

    if (
      (user.role === "citizen" || user.role === "business_owner") &&
      app.applicantId &&
      app.applicantId !== user.id
    ) {
      return sendError(res, "You are not authorized to resubmit this application", "FORBIDDEN", null, 403);
    }

    const serverUrl = `${req.protocol}://${req.get("host")}`;
    for (const file of files) {
      const normalizedRelativePath = file.path.replace(/\\/g, "/");
      const docType = file.fieldname || "corrected_document";
      const fileUrl = `${serverUrl}/${normalizedRelativePath}`;

      const existingDoc = await prisma.applicationDocument.findFirst({
        where: { applicationId: app.id, documentType: docType },
      });

      if (existingDoc) {
        await prisma.applicationDocument.update({
          where: { id: existingDoc.id },
          data: {
            originalName: file.originalname,
            fileName: file.filename,
            url: fileUrl,
            uploadedAt: new Date(),
          },
        });
      } else {
        await prisma.applicationDocument.create({
          data: {
            applicationId: app.id,
            documentType: docType,
            originalName: file.originalname,
            fileName: file.filename,
            url: fileUrl,
          },
        });
      }
    }

    const existingFd = (app.formData && typeof app.formData === "object")
      ? (app.formData as Record<string, any>)
      : {};
    let parsedUpdatedFields: Record<string, any> = {};
    if (updatedFields) {
      try {
        parsedUpdatedFields = typeof updatedFields === "string" ? JSON.parse(updatedFields) : updatedFields;
      } catch {}
    }

    const applicantNote = String(comment || correctionResponse || "Corrected documents/information submitted by applicant.").trim();

    const updated = await prisma.application.update({
      where: { id: app.id },
      data: {
        status: "submitted",
        declineReason: null,
        formData: {
          ...existingFd,
          ...parsedUpdatedFields,
          subAdminReview: {
            ...(existingFd.subAdminReview || {}),
            status: "resubmitted_by_applicant",
            resubmittedAt: new Date().toISOString(),
            applicantNote,
          },
          lastResubmittedAt: new Date().toISOString(),
          applicantCorrectionNote: applicantNote,
        },
      },
      include: {
        service: true,
        applicant: true,
        applicationDocuments: true,
        invoice: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        action: "application_submitted",
        entity: "Application",
        entityId: app.id,
        userId: user.id,
        details: {
          action: "applicant_resubmission_after_correction",
          applicantNote,
          uploadedFilesCount: files.length,
        },
        ipAddress: req.ip,
      },
    });

    return sendSuccess(res, updated, "Application resubmitted for Sub-Admin review");
  } catch (err) {
    next(err);
  }
};
