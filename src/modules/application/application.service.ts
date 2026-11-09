
export function extractMarriageData(fdRaw: any) {
  const fd = (fdRaw && typeof fdRaw === 'object') ? fdRaw : {};
  const rawDate = fd.weddingDate || fd.marriageDate;
  const weddingDate = rawDate ? new Date(rawDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return {
    groomFullName: String(fd.groomFullName || fd.groomName || fd.fullName || "Groom").trim(),
    groomCondition: String(fd.groomCondition || "Bachelor").trim(),
    groomOccupation: String(fd.groomOccupation || "Private Sector").trim(),
    groomAge: Number(fd.groomAge) || 25,
    groomDateOfBirth: fd.groomDateOfBirth ? String(fd.groomDateOfBirth) : null,
    groomAddress: String(fd.groomAddress || fd.groomDwelling || fd.address || "").trim(),
    groomPhone: String(fd.groomPhone || fd.phone || "").trim(),
    groomNin: fd.groomNin ? String(fd.groomNin) : null,
    groomFatherName: String(fd.groomFatherName || "Father of Groom").trim(),
    groomFatherOccupation: String(fd.groomFatherOccupation || "Self Employed").trim(),
    brideFullName: String(fd.brideFullName || fd.brideName || "Bride").trim(),
    brideCondition: String(fd.brideCondition || "Spinster").trim(),
    brideOccupation: String(fd.brideOccupation || "Private Sector").trim(),
    brideAge: Number(fd.brideAge) || 23,
    brideDateOfBirth: fd.brideDateOfBirth ? String(fd.brideDateOfBirth) : null,
    brideAddress: String(fd.brideAddress || fd.brideDwelling || "").trim(),
    bridePhone: String(fd.bridePhone || "").trim(),
    brideNin: fd.brideNin ? String(fd.brideNin) : null,
    brideFatherName: String(fd.brideFatherName || "Father of Bride").trim(),
    brideFatherOccupation: String(fd.brideFatherOccupation || "Self Employed").trim(),
    weddingDate: isNaN(weddingDate.getTime()) ? new Date() : weddingDate,
    registryLocation: String(fd.registryLocation || fd.marriagePlace || "Ifo Local Government Marriage Registry, Secretariat, Ifo").trim(),
    marriageType: String(fd.marriageType || "Ordinance Marriage (Act)").trim(),
    noticeNumber: fd.noticeNumber ? String(fd.noticeNumber) : null,
    witness1Name: String(fd.witness1Name || "Witness 1").trim(),
    witness1Address: String(fd.witness1Address || "").trim(),
    witness1Phone: String(fd.witness1Phone || "").trim(),
    witness2Name: String(fd.witness2Name || "Witness 2").trim(),
    witness2Address: String(fd.witness2Address || "").trim(),
    witness2Phone: String(fd.witness2Phone || "").trim(),
    consentGivenBy: fd.consentGivenBy ? String(fd.consentGivenBy) : null,
    holgaApprovalStatus: "pending",
    lgRegCodeNo: "IFLG-MRG",
    certificateSerialNo: generateReceiptNumber("MRG"),
    imcBarcode: `IMC-${Math.floor(100000000000 + Math.random() * 900000000000)}`,
  };
}

import { prisma } from "../../utils/prisma";
import { generateReceiptNumber } from "../../utils/generators";
import fs from "fs";
import { notify } from "../notification/notification.service";
import { Prisma } from "@prisma/client";

type UploadedFileMeta = {
  originalName: string;
  fileName: string;
  relativePath: string; // path on disk, normalized with forward slashes
  url: string;
  documentType?: string | null;
  absolutePath?: string;
};

interface CreateOrUpdateAppParams {
  mode: "create" | "complete";
  applicationId?: string;
  applicantId?: string | null;
  createdById?: string | null;
  serviceId: string;
  formData: Prisma.InputJsonValue;
  files?: UploadedFileMeta[];
  createInvoice?: boolean;
}

export const createOrUpdateApplication = async (
  params: CreateOrUpdateAppParams,
) => {
  const {
    mode,
    applicationId,
    applicantId,
    createdById,
    serviceId,
    formData,
    files,
    createInvoice = true,
  } = params;

  const result = await prisma.$transaction(async (tx) => {
    // ============================================================
    // COMPLETE EXISTING APPLICATION
    // ============================================================
    if (mode === "complete") {
      if (!applicationId) {
        const err: any = new Error("Application ID is required");
        err.statusCode = 400;
        err.code = "APPLICATION_ID_REQUIRED";
        throw err;
      }

      console.log("COMPLETE files:", files?.length);
      console.log(
        "COMPLETE file fields:✅",
        files
      );
      const application = await tx.application.findUnique({
        where: { id: applicationId },
        include: {
          service: true,
          applicant: true,
          applicationDocuments: true,
      marriageRecord: { include: { holgaApprovedBy: { select: { id: true, firstName: true, lastName: true, role: true } } } },
        },
      });

      if (!application) {
        const err: any = new Error("Application not found");
        err.statusCode = 404;
        err.code = "APPLICATION_NOT_FOUND";
        throw err;
      }

      // Do not allow the completion request to switch services.
      if (application.serviceId !== serviceId) {
        const err: any = new Error(
          "The service cannot be changed when completing an application",
        );
        err.statusCode = 400;
        err.code = "SERVICE_CHANGE_NOT_ALLOWED";
        throw err;
      }

      // If an applicant was supplied, make sure it matches.
      if (
        applicantId &&
        application.applicantId &&
        applicantId !== application.applicantId
      ) {
        const err: any = new Error(
          "You cannot complete an application for another applicant",
        );
        err.statusCode = 403;
        err.code = "APPLICANT_MISMATCH";
        throw err;
      }

      // Check if invoice payment has been confirmed
      const inv = await tx.invoice.findFirst({
        where: { applicationId: application.id },
        orderBy: { createdAt: "desc" },
      });
      const isPaid = inv?.paymentStatus === "confirmed";
      // If payment is already confirmed, advance to "submitted" for Sub-Admin first-level review.
      // If payment is still awaiting verification, retain "awaiting_payment_confirmation"
      // so unconfirmed claims do not bypass the Treasury confirmation gateway!
      const nextStatus = isPaid ? "submitted" : "awaiting_payment_confirmation";

      const existingFormData =
        application.formData && typeof application.formData === "object"
          ? (application.formData as Record<string, any>)
          : {};
      const newFormData =
        formData && typeof formData === "object"
          ? (formData as Record<string, any>)
          : {};
      const mergedFormData = {
        ...existingFormData,
        ...newFormData,
        _formCompleted: true,
        _formCompletedAt: new Date().toISOString(),
      };

      // Update the actual application.
      await tx.application.update({
        where: { id: applicationId },
        data: {
          formData: mergedFormData,
          status: nextStatus,
        },
        include: {
          service: true,
          applicant: true,
          applicationDocuments: true,
          invoice: true,
        },
      });

      // Replace uploaded documents by documentType.
      if (files && files.length > 0) {
        for (const file of files) {
          const existingDocument = await tx.applicationDocument.findFirst({
            where: {
              applicationId,
              documentType: file.documentType ?? "supporting_document",
            },
          });

          if (existingDocument) {
            await tx.applicationDocument.update({
              where: {
                id: existingDocument.id,
              },
              data: {
                originalName: file.originalName,
                fileName: file.fileName,
                url: file.url,
              },
            });
          } else {
            await tx.applicationDocument.create({
              data: {
                applicationId,
                documentType: file.documentType ?? "supporting_document",
                originalName: file.originalName,
                fileName: file.fileName,
                url: file.url,
              },
            });
          }
        }
      }

      if (application.service?.code === "marriage_certificate" || (formData && (formData as any).groomFullName)) {
        const mrgData = extractMarriageData(formData);
        await (tx as any).marriageRecord.upsert({
          where: { applicationId },
          create: {
            applicationId,
            ...mrgData,
          },
          update: {
            ...mrgData,
          },
        });
      }

      return {
        application: await tx.application.findUnique({
          where: { id: applicationId },
          include: {
            service: true,
            applicant: true,
            applicationDocuments: true,
            invoice: true,
          },
        }),
        invoice: await tx.invoice.findUnique({
          where: { applicationId },
        }),
      };
    }

    // ============================================================
    // CREATE NEW APPLICATION
    // ============================================================

    const service = await tx.service.findUnique({
      where: { id: serviceId },
      include: { feeConfig: true },
    });

    if (!service) {
      const err: any = new Error("Service not found");
      err.statusCode = 404;
      err.code = "SERVICE_NOT_FOUND";
      throw err;
    }

    if (!service.isActive) {
      const err: any = new Error("Service is not active");
      err.statusCode = 400;
      err.code = "SERVICE_INACTIVE";
      throw err;
    }

    const feeConfig = await tx.serviceFeeConfig.findUnique({
      where: { serviceId },
    });

    const fdObj: any = (formData && typeof formData === "object") ? formData : {};
    const isCustomUnclassifiedProperty =
      fdObj.classification === "other" || fdObj.requiresOfficerClassification === true;
    const dynamicCalculatedFee = Number(fdObj.totalAssessment ?? fdObj.assessedFee ?? 0);

    let feeAmount: Prisma.Decimal;
    if (isCustomUnclassifiedProperty) {
      // Do NOT invent an automatic fee for custom property descriptions — route to officer for classification
      feeAmount = new Prisma.Decimal(0);
    } else if (dynamicCalculatedFee > 0) {
      feeAmount = new Prisma.Decimal(dynamicCalculatedFee);
    } else if (feeConfig && feeConfig.status === "ACTIVE") {
      feeAmount = feeConfig.amount;
    } else {
      feeAmount = new Prisma.Decimal(0);
    }

    const appNumber = generateReceiptNumber("APP");
    const enrichedFormData: any = {
      ...fdObj,
      termsAccepted: true,
      termsAcceptedAt: fdObj.termsAcceptedAt || new Date().toISOString(),
      termsVersion: fdObj.termsVersion || "v1.0-2026-IFO-LGA",
      termsAcceptedByApplicantId: applicantId || createdById || null,
      termsApplicationNumber: appNumber,
    };

    const createData: any = {
      applicationNumber: appNumber,
      service: {
        connect: { id: serviceId },
      },
      feeAmount,
      formData: enrichedFormData,
      status: "submitted",
    };

    if (applicantId) {
      createData.applicant = {
        connect: { id: applicantId },
      };
    }

    if (createdById) {
      createData.createdBy = {
        connect: { id: createdById },
      };
    } else if (applicantId) {
      createData.createdBy = {
        connect: { id: applicantId },
      };
    }

    // Create Marriage Record if service is marriage_certificate
    const application = await tx.application.create({
      data: createData,
      include: {
        service: true,
        applicant: true,
      },
    });

    if (service.code === "marriage_certificate" || (formData && (formData as any).groomFullName)) {
      const mrgData = extractMarriageData(formData);
      await (tx as any).marriageRecord.create({
        data: {
          applicationId: application.id,
          ...mrgData,
        },
      });
    }

    let invoice = null;

    if (createInvoice) {
      const invoiceCreatorId = createdById || applicantId;

      invoice = await tx.invoice.create({
        data: {
          invoiceNumber: generateReceiptNumber("INV"),
          application: {
            connect: { id: application.id },
          },
          service: {
            connect: { id: serviceId },
          },
          amount: feeAmount,
          paymentStatus: "pending",
          ...(invoiceCreatorId
            ? {
                createdBy: {
                  connect: { id: invoiceCreatorId },
                },
              }
            : {}),
        },
      });
    }

    // Record Terms & Conditions acceptance in AuditLog
    try {
      await tx.auditLog.create({
        data: {
          action: "declaration_accepted",
          entity: "Application",
          entityId: application.id,
          userId: applicantId || createdById || undefined,
          details: {
            applicationNumber: application.applicationNumber,
            applicantId: applicantId || createdById || null,
            acceptedAt: enrichedFormData.termsAcceptedAt,
            version: enrichedFormData.termsVersion,
          },
        },
      });
    } catch {}

    if (files && files.length > 0) {
      for (const file of files) {
        await tx.applicationDocument.create({
          data: {
            applicationId: application.id,
            documentType: file.documentType ?? "supporting_document",
            originalName: file.originalName,
            fileName: file.fileName,
            url: file.url,
          },
        });
      }
    }

    return {
      application,
      invoice,
    };
  });

  return result;
};

export const getApplicationByIdOrNumber = async (idOrNumber: string) => {
  const app = await prisma.application.findFirst({
    where: { OR: [{ id: idOrNumber }, { applicationNumber: idOrNumber }] },
    include: {
      service: true,
      invoice: true,
      certificate: true,
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
  });
  return app;
};

export const listApplicationsForUser = async (
  user: any,
  page = 1,
  limit = 25,
  filters: Record<string, unknown> = {},
) => {
  const skip = (page - 1) * limit;
  const where: any = {};

  if (user.role === "citizen" || user.role === "business_owner") {
    where.applicantId = user.id;
  } else if (user.role === "field_officer") {
    where.createdById = user.id;
  }
    if (typeof filters.status === "string" && filters.status) where.status = filters.status;
    if (typeof filters.serviceId === "string" && filters.serviceId) where.serviceId = filters.serviceId;
    if (typeof filters.search === "string" && filters.search.trim()) {
      const contains = filters.search.trim();
      where.OR = [
        { applicationNumber: { contains, mode: "insensitive" } },
        { applicant: { is: { OR: ["firstName", "lastName", "email", "phone"].map((key) => ({ [key]: { contains, mode: "insensitive" } })) } } },
        ...["fullName", "email", "phone"].map((key) => ({ formData: { path: [key], string_contains: contains, mode: "insensitive" } })),
      ];
    }
    if (typeof filters.wardId === "string" && filters.wardId) {
      where.AND = [{ OR: [
        { formData: { path: ["ward"], equals: filters.wardId } },
        { applicant: { is: { ward: { is: { name: filters.wardId } } } } },
      ] }];
    }
  // For privileged roles (super_admin, lga_admin, etc.) - no restrictions

  const items = await prisma.application.findMany({
    where,
    select: {
      id: true,
      applicationNumber: true,
      status: true,
      feeAmount: true,
      formData: true,
      paymentFirst: true,
      createdAt: true,
      updatedAt: true,
      reviewedAt: true,
      declineReason: true,
      serviceId: true,
      applicantId: true,
      createdById: true,
      reviewedById: true,
      service: {
        select: {
          id: true,
          code: true,
          name: true,
          category: true,
          revenueHead: true,
          description: true,
          estimatedDays: true,
          certificateType: true,
          isActive: true,
        },
      },
      invoice: {
        select: {
          id: true,
          invoiceNumber: true,
          amount: true,
          paymentStatus: true,
          paidAt: true,
          transactionRef: true,
          virtualAccountNumber: true,
          virtualBankName: true,
          payments: {
            select: {
              method: true,
            },
          },
        },
      },
      certificate: {
        select: {
          id: true,
          certificateNumber: true,
          verificationCode: true,
          issuedAt: true,
          expiresAt: true,
          pdfUrl: true,
          issuedBy: true,
        },
      },
      applicationDocuments: {
        select: {
          id: true,
          documentType: true,
          originalName: true,
          fileName: true,
          url: true,
          mimeType: true,
          fileSize: true,
          uploadedAt: true,
        },
        orderBy: {
          uploadedAt: "desc",
        },
        take: 10, // Limit to most recent 10 documents
      },
      applicant: {
        select: {
          id: true,
          email: true,
          phone: true,
          firstName: true,
          lastName: true,
          role: true,
          address: true,
          town: true,
        },
      },
      createdBy: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
        },
      },
      reviewedBy: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    skip,
    take: limit,
  });

  const total = await prisma.application.count({ where });

  return {
    items,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPreviousPage: page > 1,
    },
  };
};
