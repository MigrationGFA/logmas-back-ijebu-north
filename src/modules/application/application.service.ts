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

      // Update the actual application.
      await tx.application.update({
        where: { id: applicationId },
        data: {
          formData, // changed from `JSON`,
          status: "submitted",
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

    if (!feeConfig || feeConfig.status !== "ACTIVE") {
      const err: any = new Error("Service fee not configured");
      err.statusCode = 400;
      err.code = "SERVICE_FEE_NOT_CONFIGURED";
      throw err;
    }

    const feeAmount = feeConfig.amount;

    const createData: any = {
      applicationNumber: generateReceiptNumber("APP"),
      service: {
        connect: { id: serviceId },
      },
      feeAmount,
      formData,
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

    const application = await tx.application.create({
      data: createData,
      include: {
        service: true,
        applicant: true,
      },
    });

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

    if (!files) {
      const err: any = new Error("Files not uploaded");
      err.statusCode = 400;
      err.code = "FILES_NOT_UPLOADED";
      throw err;
    }

    if (files.length > 0) {
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
