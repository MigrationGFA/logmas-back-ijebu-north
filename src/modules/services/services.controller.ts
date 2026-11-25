import { Request, Response, NextFunction } from "express";
import { sendSuccess, sendError } from "../../utils/response";
import * as ServiceService from "./service.service";
import { queryString } from "../complaints/complaints.controller";
import { Role, ServiceCategory, CertificateType } from "@prisma/client";
import { verifyAccessToken } from "../../utils/jwt";
import { prisma } from "../../utils/prisma";

// Staff roles other than field officer. The catalogue routes are
// public (no requireAuth), so the caller's role is read from the bearer
// token when one is present.
const STAFF_ROLES: Role[] = [
  "treasurer",
  "lga_admin",
  "super_admin",
  "sub_admin",
  "auditor",
  "chairman",
];

// How much of the catalogue a caller may see. A field officer sees
// FO-only services and nothing else (Nov 25, 2026 ruling); other staff
// see the whole catalogue; anonymous and citizen callers see public
// services only.
type CatalogueScope = "public" | "staff" | "field_officer";

function callerScope(req: Request): CatalogueScope {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return "public";
  try {
    const decoded = verifyAccessToken(header.split(" ")[1]);
    if (decoded.role === "field_officer") return "field_officer";
    return STAFF_ROLES.includes(decoded.role as Role) ? "staff" : "public";
  } catch {
    return "public";
  }
}

async function writeServiceAudit(
  action: "service_created" | "service_updated" | "service_deleted",
  userId: string,
  service: { id: string; code: string; name: string; foOnly?: boolean },
  details: Record<string, unknown>,
) {
  await prisma.auditLog.create({
    data: {
      action,
      entity: "Service",
      entityId: service.id,
      userId,
      details: {
        code: service.code,
        name: service.name,
        foOnly: service.foOnly ?? false,
        ...details,
      } as any,
    },
  });
}

export const listServices = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const category = queryString(req.query.category);

    const services = await ServiceService.listActiveServices(category, callerScope(req));

    return sendSuccess(res, services);
  } catch (err) {
    next(err);
  }
};

export const getServiceByCode = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { code } = req.params;

    const service = await ServiceService.getActiveServiceByCode(String(code), callerScope(req));

    if (!service) {
      return sendError(
        res,
        "Service not found",
        "NOT_FOUND",
        null,
        404,
      );
    }

    return sendSuccess(res, service);
  } catch (err) {
    next(err);
  }
};

export const createServiceController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id: userId, role } = req.user!;

    // Authorization check - only super_admin and lga_admin can create services
    const allowedRoles: Role[] = ["super_admin", "lga_admin", "treasurer"];
    if (!allowedRoles.includes(role)) {
      return sendError(
        res,
        "You don't have permission to create services",
        "FORBIDDEN",
        null,
        403,
      );
    }

    // Validate required fields
    const {
      code,
      name,
      category,
      revenueHead,
      description,
      requirements,
      estimatedDays,
      certificateType,
      supportsRenewal,
      isActive,
      foOnly,
      feeConfig,
    } = req.body;

    if (!code || !name || !category || !revenueHead || !certificateType) {
      return sendError(
        res,
        "Missing required fields: code, name, category, revenueHead, certificateType",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }

    // FO-only services carry no fixed fee: the collecting officer records
    // the amount actually paid per collection, so no fee config is needed.
    const isFoOnly = foOnly === true;
    if (!isFoOnly && (!feeConfig || !feeConfig.amount || !feeConfig.effectiveDate)) {
      return sendError(
        res,
        "Fee configuration is required with amount and effectiveDate",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }

    const result = await ServiceService.createService(
      {
        code,
        name,
        category,
        revenueHead,
        description: description || "",
        requirements: requirements || [],
        estimatedDays: estimatedDays || 3,
        certificateType,
        supportsRenewal: supportsRenewal || false,
        isActive: isActive !== undefined ? isActive : true,
        foOnly: isFoOnly,
        feeConfig: feeConfig
          ? {
              amount: Number(feeConfig.amount),
              expiryDate: feeConfig.expiryDate ? new Date(feeConfig.expiryDate) : undefined,
            }
          : undefined,
      },
      userId,
    );

    await writeServiceAudit("service_created", userId, result.service, {
      category,
    });

    return sendSuccess(res, {
      message: "Service created successfully",
      data: result,
    });
  } catch (err: any) {
    if (err.message.includes("already exists")) {
      return sendError(
        res,
        err.message,
        "CONFLICT",
        null,
        409,
      );
    }
    if (err.message.includes("must be")) {
      return sendError(
        res,
        err.message,
        "VALIDATION_ERROR",
        null,
        400,
      );
    }
    next(err);
  }
};


export const updateServiceController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id: userId, role } = req.user!;
    const { id } = req.params;

    // Authorization check - only super_admin and lga_admin can update services
    const allowedRoles: Role[] = ["super_admin", "lga_admin", "treasurer"];
    if (!allowedRoles.includes(role)) {
      return sendError(
        res,
        "You don't have permission to update services",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const {
      code,
      name,
      category,
      revenueHead,
      description,
      requirements,
      estimatedDays,
      certificateType,
      supportsRenewal,
      isActive,
      foOnly,
      feeConfig,
    } = req.body;

    // Category and certificate type are database enums. Reject anything
    // outside them here with a clean message, instead of letting the
    // value reach the database and come back as a raw technical error
    // (which is what used to kill Edit Service saves from the modal).
    if (
      category !== undefined &&
      !Object.values(ServiceCategory).includes(category)
    ) {
      return sendError(
        res,
        "Invalid service category",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }
    if (
      certificateType !== undefined &&
      !Object.values(CertificateType).includes(certificateType)
    ) {
      return sendError(
        res,
        "Invalid certificate type",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }

    // Prepare update data - only include fields that are provided
    const updateData: any = {};

    if (code !== undefined) updateData.code = code;
    if (name !== undefined) updateData.name = name;
    if (category !== undefined) updateData.category = category;
    if (revenueHead !== undefined) updateData.revenueHead = revenueHead;
    if (description !== undefined) updateData.description = description;
    if (requirements !== undefined) updateData.requirements = requirements;
    if (estimatedDays !== undefined) updateData.estimatedDays = estimatedDays;
    if (certificateType !== undefined) updateData.certificateType = certificateType;
    if (supportsRenewal !== undefined) updateData.supportsRenewal = supportsRenewal;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (foOnly !== undefined) updateData.foOnly = foOnly;

    if (feeConfig !== undefined) {
      updateData.feeConfig = {
        amount: feeConfig.amount !== undefined ? Number(feeConfig.amount) : undefined,
        effectiveDate: feeConfig.effectiveDate !== undefined 
          ? new Date(feeConfig.effectiveDate) 
          : undefined,
        expiryDate: feeConfig.expiryDate !== undefined 
          ? (feeConfig.expiryDate ? new Date(feeConfig.expiryDate) : null)
          : undefined,
        notes: feeConfig.notes !== undefined ? feeConfig.notes : undefined,
        status: feeConfig.status !== undefined ? feeConfig.status : undefined,
      };
    }

    const result = await ServiceService.updateService(
      String(id),
      updateData,
      userId,
    );

    await writeServiceAudit("service_updated", userId, result.service, {
      changedFields: Object.keys(updateData),
    });

    return sendSuccess(res, {
      message: "Service updated successfully",
      data: result,
    });
  } catch (err: any) {
    if (err.message.includes("not found")) {
      return sendError(
        res,
        err.message,
        "NOT_FOUND",
        null,
        404,
      );
    }
    if (err.message.includes("already exists")) {
      return sendError(
        res,
        err.message,
        "CONFLICT",
        null,
        409,
      );
    }
    if (err.message.includes("must be") || err.message.includes("required")) {
      return sendError(
        res,
        err.message,
        "VALIDATION_ERROR",
        null,
        400,
      );
    }
    next(err);
  }
};
export const deleteServiceController = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id: userId, role } = req.user!;
    const { id } = req.params;

    // Same roles that may create or update services.
    const allowedRoles: Role[] = ["super_admin", "lga_admin", "treasurer"];
    if (!allowedRoles.includes(role)) {
      return sendError(
        res,
        "You don't have permission to delete services",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const result = await ServiceService.deleteService(String(id));

    await writeServiceAudit("service_deleted", userId, result.service, {
      mode: result.mode,
    });

    return sendSuccess(res, {
      message:
        result.mode === "deleted"
          ? "Service deleted successfully"
          : "Service has existing records, so it was deactivated instead of deleted",
      data: result,
    });
  } catch (err: any) {
    if (err.message.includes("not found")) {
      return sendError(res, err.message, "NOT_FOUND", null, 404);
    }
    next(err);
  }
};
