import { Request, Response, NextFunction } from "express";
import { sendSuccess, sendError } from "../../utils/response";
import * as ServiceService from "./service.service";
import { queryString } from "../complaints/complaints.controller";
import { Role } from "@prisma/client";
import { verifyAccessToken } from "../../utils/jwt";
import { prisma } from "../../utils/prisma";

// Roles that may see FO-only services. The catalogue routes are public
// (no requireAuth), so the caller's role is read from the bearer token
// when one is present; anonymous and citizen callers never see FO-only
// services.
const STAFF_ROLES: Role[] = [
  "field_officer",
  "treasurer",
  "lga_admin",
  "super_admin",
  "sub_admin",
  "auditor",
  "chairman",
];

function callerIsStaff(req: Request): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;
  try {
    const decoded = verifyAccessToken(header.split(" ")[1]);
    return STAFF_ROLES.includes(decoded.role as Role);
  } catch {
    return false;
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

    const services = await ServiceService.listActiveServices(category, callerIsStaff(req));

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

    const service = await ServiceService.getActiveServiceByCode(String(code), callerIsStaff(req));

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
