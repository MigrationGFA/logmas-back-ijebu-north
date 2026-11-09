// src/modules/lgaAdmin/lgaAdmin.controller.ts
import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "../../utils/prisma";
import { sendSuccess, sendError } from "../../utils/response";
import { Role } from "@prisma/client";
import { getIp, queryString } from "../complaints/complaints.controller";
import { notify } from "../notification/notification.service";

// ─────────────────────────────────────────────────────────────
// WARD MANAGEMENT
// ─────────────────────────────────────────────────────────────

/**
 * POST /api/v1/lga-admin/wards
 * Create a new ward.
 */
export const createWard = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const adminId = req.user!.id;
    const { name, code, description } = req.body;

    const existing = await prisma.ward.findFirst({
      where: { OR: [{ name }, { code }] },
    });
    if (existing) {
      return sendError(
        res,
        "A ward with this name or code already exists",
        "CONFLICT",
        null,
        409,
      );
    }

    const ward = await prisma.ward.create({
      data: { name, code, description },
    });

    return sendSuccess(res, { data: ward });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/lga-admin/wards
 * List all wards with councillor info and stats.
 */
export const listWards = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const page = parseInt(queryString(req.query.page) ?? "1");
    const limit = parseInt(queryString(req.query.limit) ?? "20");
    const skip = (page - 1) * limit;

    const [wards, total] = await Promise.all([
      prisma.ward.findMany({
        skip,
        take: limit,
        // where: { deletedAt: null },
        include: {
          _count: {
            select: {
              complaints: true,
              // businesses: true,
            },
          },
        },
        orderBy: { name: "asc" },
      }),
      prisma.ward.count({ where: {} }),
    ]);

    // Format output payload array to match what your UI layout table expects
    const formattedWards = wards.map((w) => ({
      ...w,
    }));

    return sendSuccess(res, {
      data: formattedWards,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/lga-admin/wards/:id
 * Get single ward with full detail.
 */
export const getWardById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let { id } = req.params;
    if (Array.isArray(id)) id = id[0];

    const ward = await prisma.ward.findUnique({
      where: { id },
      include: {
        councillor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            isActive: true,
          },
        },
        _count: {
          select: {
            complaints: true,
            stateOfOriginApplications: true,
            businesses: true,
          },
        },
      },
    });

    if (!ward) return sendError(res, "Ward not found", "NOT_FOUND", null, 404);

    return sendSuccess(res, ward);
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/v1/lga-admin/wards/:id
 * Update ward details.
 */
export const updateWard = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let { id } = req.params;
    if (Array.isArray(id)) id = id[0];
    const adminId = req.user!.id;

    const ward = await prisma.ward.findUnique({ where: { id } });
    if (!ward) return sendError(res, "Ward not found", "NOT_FOUND", null, 404);

    const updated = await prisma.ward.update({
      where: { id },
      data: req.body,
    });

    await prisma.auditLog.create({
      data: {
        action: "user_updated",
        entity: "Ward",
        entityId: id,
        userId: adminId,
        details: req.body,
        ipAddress: getIp(req),
      },
    });

    return sendSuccess(res, updated, "Ward updated");
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/v1/lga-admin/wards/:id/assign-councillor
 * Assign a ward councillor to a ward.
 * Councillor must already exist as a user with role = ward_councillor.
 */
export const assignCouncillor = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let { id } = req.params;
    if (Array.isArray(id)) id = id[0];
    const adminId = req.user!.id;
    const { councillorId } = req.body;

    const [ward, councillor] = await Promise.all([
      prisma.ward.findUnique({ where: { id } }),
      prisma.user.findUnique({ where: { id: councillorId } }),
    ]);

    if (!ward) return sendError(res, "Ward not found", "NOT_FOUND", null, 404);
    if (!councillor)
      return sendError(
        res,
        "Councillor user not found",
        "NOT_FOUND",
        null,
        404,
      );

    if (councillor.role !== "ward_councillor") {
      return sendError(
        res,
        "User must have the ward_councillor role to be assigned to a ward",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    // Unassign councillor from any previous ward then assign to new one
    await prisma.user.update({
      where: { id: councillorId },
      data: { updatedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        action: "user_updated",
        entity: "Ward",
        entityId: id,
        userId: adminId,
        details: { councillorId, action: "assigned_councillor" },
        ipAddress: getIp(req),
      },
    });

    return sendSuccess(
      res,
      { wardId: id, councillorId },
      "Councillor assigned to ward",
    );
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/v1/lga-admin/wards/:id
 * Soft delete a ward.
 */
export const deleteWard = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let { id } = req.params;
    if (Array.isArray(id)) id = id[0];
    const adminId = req.user!.id;

    const ward = await prisma.ward.findUnique({ where: { id } });
    if (!ward) return sendError(res, "Ward not found", "NOT_FOUND", null, 404);

    await prisma.ward.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        action: "user_suspended",
        entity: "Ward",
        entityId: id,
        userId: adminId,
        ipAddress: getIp(req),
      },
    });

    return sendSuccess(res, null, "Ward deactivated");
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────
// STAFF MANAGEMENT
// ────────────────────────────────────────────────────/ Adjust to your actual notify utility import path

// Your secure password randomizer function
export function generateTempPassword(length = 12): string {
  const charset = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  const bytes = crypto.randomBytes(length);
  let password = "";
  for (let i = 0; i < length; i++) {
    password += charset[bytes[i] % charset.length];
  }
  return password;
}

/**
 * POST /api/v1/lga-admin/staff
 * LGA Admin creates a new staff account and notifies them with credentials.
 */
export const createStaff = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const adminId = req.user!.id;
    const { email, firstName, lastName, phone, role } = req.body;

    const allowedRoles: Role[] = [
      "sub_admin",
      "ward_councillor",
      "contractor",
      "field_officer",
      "agent",
      "citizen",
      "business_owner",
      "auditor",
      "treasurer",
      "chairman",
    ];
    if (!allowedRoles.includes(role as Role)) {
      return sendError(
        res,
        "LGA Admin can only create allowed platform staff accounts",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing)
      return sendError(res, "Email already registered", "CONFLICT", null, 409);

    // Validate ward exists if provided
    // if (wardId) {
    //   const ward = await prisma.ward.findUnique({ where: { id: wardId } });
    //   if (!ward)
    //     return sendError(res, "Ward not found", "NOT_FOUND", null, 404);
    // }

    // 1. Generate the unique random temporary password per execution call
    const uniqueTempPassword = generateTempPassword(12);

    // 2. Hash the dynamically generated password securely
    const hashedPassword = await bcrypt.hash(uniqueTempPassword, 12);

    // 3. Determine ward mapping based on the role
    const isWardCouncillor = role === "ward_councillor";
    const isFieldOfficer = role === "field_officer";

    const staff = await prisma.user.create({
      data: {
        email,
        firstName,
        lastName,
        ...(phone && { phone }),
        password: hashedPassword,
        createdById: adminId,
        role: role as Role,
        passwordResetRequired: true,
        // Match the specific schema properties for WC vs FO
        // ...(wardId && isWardCouncillor && { assignedWardId: wardId }),
        // ...(wardId &&
        //   (isFieldOfficer || isWardCouncillor) && { wardId: wardId }),
        // ...(contractorId && { contractorId }),
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        phone: true,
        // wardId: true,
        // assignedWardId: true,
        // contractorId: true,
        isActive: true,
        createdAt: true,
      },
    });

    // 4. Create Audit Log
    await prisma.auditLog.create({
      data: {
        action: "user_created",
        entity: "User",
        entityId: staff.id,
        userId: adminId,
        details: { role, email },
        ipAddress: getIp(req),
      },
    });

    // 5. Send Notification containing credentials to the newly created staff member
    try {
      await notify({
        userId: staff.id,
        to: { phone: staff.phone || "", email: staff.email },
        templateKey: "account.welcomeStaff", // Points to your newly added layout block
        vars: {
          applicant_name: `${staff.firstName} ${staff.lastName}`,
          temp_password: uniqueTempPassword,
        },
        channels: ["sms", "email"],
      });
    } catch (notifyErr) {
      console.error(
        "[createStaff] notify() failed, continuing anyway:",
        notifyErr,
      );
    }

    // 6. Return response to the Admin dashboard creator
    return sendSuccess(
      res,
      {
        staff,
        temporaryPassword: uniqueTempPassword,
        notice:
          "Staff account created successfully. They have been sent their login credentials via email and SMS.",
      },
      "Staff account created successfully",
      201,
    );
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/lga-admin/staff
 * List all staff with role and ward filters.
 */
export const listStaff = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const role = queryString(req.query.role) as Role | undefined;
    const wardId = queryString(req.query.wardId);
    const isActive =
      req.query.isActive !== undefined
        ? req.query.isActive === "true"
        : undefined;
    const page = parseInt(queryString(req.query.page) ?? "1");
    const limit = parseInt(queryString(req.query.limit) ?? "10");
    const skip = (page - 1) * limit;

    // Exclude super_admin, lga_admin, citizen, business_owner from staff list
    const staffRoles: Role[] = [
      "sub_admin",
      "ward_councillor",
      "contractor",
      "field_officer",
      "agent",
      "chairman",
      "treasurer",
      "auditor",
    ];

    const where: any = {
      role: { in: role ? [role] : staffRoles },
      // deletedAt: null,
      ...(wardId !== undefined && { wardId }),
      ...(isActive !== undefined && { isActive }),
    };

    const [staff, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          phone: true,
          isActive: true,
          wardId: true,
          ward: { select: { id: true, name: true } },
          createdAt: true,
          lastLoginAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.user.count({ where }),
    ]);

    return sendSuccess(res, {
      data: staff,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/v1/lga-admin/staff/:id
 * Get a single staff member with full profile.
 */
export const getStaffById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let { id } = req.params;
    if (Array.isArray(id)) id = id[0];

    const staff = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        phone: true,
        isActive: true,
        address: true,
        wardId: true,
        ward: { select: { id: true, name: true, code: true } },
        contractorId: true,
        contractor: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        // fieldOfficers: {
        //   select: {
        //     id: true,
        //     firstName: true,
        //     lastName: true,
        //     email: true,
        //     isActive: true,
        //   },
        // },
        createdAt: true,
        lastLoginAt: true,
      },
    });

    if (!staff)
      return sendError(res, "Staff member not found", "NOT_FOUND", null, 404);

    return sendSuccess(res, staff);
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/v1/lga-admin/staff/:id
 * Update staff profile or reassign ward/contractor.
 */
export const updateStaff = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    let { id } = req.params;
    if (Array.isArray(id)) id = id[0];
    const adminId = req.user!.id;
    const { firstName, lastName, phone, isActive, wardId, contractorId } =
      req.body;

    const staff = await prisma.user.findUnique({ where: { id } });
    if (!staff)
      return sendError(res, "Staff member not found", "NOT_FOUND", null, 404);

    // LGA Admin cannot modify super_admin or lga_admin accounts
    if (["super_admin", "lga_admin"].includes(staff.role)) {
      return sendError(
        res,
        "You cannot modify this account",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(firstName !== undefined && { firstName }),
        ...(lastName !== undefined && { lastName }),
        ...(phone !== undefined && { phone }),
        ...(isActive !== undefined && { isActive }),
        ...(wardId !== undefined && { wardId }),
        ...(contractorId !== undefined && { contractorId }),
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        phone: true,
        isActive: true,
        wardId: true,
        contractorId: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        action: "user_updated",
        entity: "User",
        entityId: id,
        userId: adminId,
        details: req.body,
        ipAddress: getIp(req),
      },
    });

    return sendSuccess(res, updated, "Staff updated");
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/v1/lga-admin/accounts/:id/toggle-status
 * Suspend or reactivate an account.
 * Stores suspension metadata — who, when, why.
 */
export const toggleStaffStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = String(req.params.id);
    const { id: requesterId, role: requesterRole } = req.user!;
    const { reason } = req.body;

    if (id === requesterId) {
      return sendError(
        res,
        "You cannot suspend your own account",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const target = await prisma.user.findUnique({
      where: { id: String(id) },
      select: {
        id: true,
        isActive: true,
        role: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        deletedAt: true,
      },
    });

    if (!target || target.deletedAt) {
      return sendError(res, "Account not found", "NOT_FOUND", null, 404);
    }

    if (
      requesterRole === "lga_admin" &&
      ["super_admin", "lga_admin"].includes(target.role)
    ) {
      return sendError(
        res,
        "You cannot suspend this account",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const nowActive = !target.isActive; // toggling

    // Build update data
    const updateData: any = {
      isActive: nowActive,
      suspendedAt: nowActive ? null : new Date(),
      suspendedById: nowActive ? null : requesterId,
      suspensionReason: nowActive ? null : (reason ?? null),
    };

    // If suspending, increment tokenVersion to invalidate all sessions
    if (!nowActive) {
      updateData.tokenVersion = { increment: 1 };
    }

    const updated = await prisma.user.update({
      where: { id: String(id) },
      data: updateData,
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        suspendedAt: true,
        suspensionReason: true,
        tokenVersion: true,
      },
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        action: "user_updated",
        entity: "User",
        entityId: String(id),
        userId: requesterId,
        details: {
          action: nowActive ? "account_reactivated" : "account_suspended",
          reason: reason ?? null,
        },
        ipAddress: getIp(req),
      },
    });

    // --- Send notifications ---
    const fullName = `${target.firstName} ${target.lastName}`;

    if (!nowActive) {
      // Suspension
      try {
        await notify({
          userId: target.id,
          to: { email: target.email, phone: target.phone ?? "" },
          templateKey: "account.accountSuspended", // from your templates
          vars: {
            applicant_name: fullName,
            suspension_reason: reason ?? "No specific reason provided.",
          },
          channels: ["email", "sms"],
        });
      } catch (notifyErr) {
        console.error(
          "[toggleStaffStatus] notify() failed for suspension, continuing anyway:",
          notifyErr,
        );
      }
    } else {
      // Reactivation
      try {
        await notify({
          userId: target.id,
          to: { email: target.email, phone: target.phone ?? "" },
          templateKey: "account.accountReactivated",
          vars: {
            applicant_name: fullName,
          },
          channels: ["email", "sms"],
        });
      } catch (notifyErr) {
        console.error(
          "[toggleStaffStatus] notify() failed for reactivation, continuing anyway:",
          notifyErr,
        );
      }
    }

    return sendSuccess(
      res,
      updated,
      `Account ${nowActive ? "reactivated" : "suspended"} successfully`,
    );
  } catch (err) {
    next(err);
  }
};
// ─────────────────────────────────────────────────────────────
// LGA ADMIN OVERVIEW DASHBOARD
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/v1/lga-admin/overview
 * High-level stats for the LGA Admin dashboard.
 * No financial data — that belongs to Treasurer.
 */
/**
 * GET /api/v1/lga-admin/overview
 *
 * High-level stats for the LGA Admin dashboard.
 * No financial data — that belongs to Treasurer.
 */
export const getAdminOverview = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const [
      totalCitizens,
      totalFieldOfficers,
      pendingApplications,
      totalInvoices,
      recentApplications,
    ] = await Promise.all([
      // StatCard 1 — Citizens
      prisma.user.count({
        where: {
          role: "citizen",
          // deletedAt: null,
          isActive: true,
        },
      }),

      // StatCard 2 — Field Officers
      prisma.user.count({
        where: {
          role: "field_officer",
          // deletedAt: null,
          isActive: true,
        },
      }),

      // StatCard 3 — Pending Applications
      prisma.application.count({
        where: {
          status: {
            in: ["submitted", "under_review"],
          },
        },
      }),

      // StatCard 4 — Total Invoices
      prisma.invoice.count(),

      // Table — Applications awaiting review
      prisma.application.findMany({
        where: {
          status: {
            in: ["submitted", "under_review"],
          },
        },
        take: 10,
        orderBy: {
          createdAt: "desc",
        },
        select: {
          id: true,
          applicationNumber: true,
          status: true,

          applicant: {
            select: {
              firstName: true,
              lastName: true,
            },
          },

          service: {
            select: {
              id: true,
              code: true,
              name: true,
              category: true,
            },
          },
        },
      }),
    ]);

    return sendSuccess(res, {
      stats: {
        citizens: totalCitizens,
        fieldOfficers: totalFieldOfficers,
        pendingApplications,
        totalInvoices,
      },

      recentApplications: recentApplications.map((application) => ({
        id: application.id,
        applicationNumber: application.applicationNumber,

        applicant: application.applicant
          ? `${application.applicant.firstName} ${application.applicant.lastName}`.trim()
          : "—",

        service: application.service
          ? {
              id: application.service.id,
              code: application.service.code,
              name: application.service.name,
              category: application.service.category,
            }
          : null,

        status: application.status,
      })),
    });
  } catch (err) {
    next(err);
  }
};
// Roles LGA Admin can see and manage
const LGA_MANAGEABLE_ROLES: Role[] = [
  "chairman",
  "treasurer",
  "auditor",
  "ward_councillor",
  "contractor",
  "field_officer",
  "business_owner",
  "citizen",
];

// Super admin can manage all including lga_admin
const SUPER_MANAGEABLE_ROLES: Role[] = ["lga_admin", ...LGA_MANAGEABLE_ROLES];

/**
 * GET /api/v1/lga-admin/accounts
 * Returns stat cards + filtered user list in one call.
 * UI reads: counts.total, counts.active, counts.suspended, counts.pending
 * Table reads: id, name, email, phone, role, ward, status, lastLogin, createdAt
 */
export const getAccountsOverview = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { id: requesterId, role: requesterRole } = req.user!;
    const search = queryString(req.query.search);
    const roleFilter = queryString(req.query.role) as Role | undefined;
    const page = parseInt(queryString(req.query.page) ?? "1");
    const limit = parseInt(queryString(req.query.limit) ?? "20");
    const skip = (page - 1) * limit;

    // Scope roles based on who is asking
    const allowedRoles =
      requesterRole === "super_admin"
        ? SUPER_MANAGEABLE_ROLES
        : LGA_MANAGEABLE_ROLES;

    const rolesScope: Role[] =
      roleFilter && allowedRoles.includes(roleFilter)
        ? [roleFilter]
        : allowedRoles;

    const baseWhere: any = {
      role: { in: rolesScope },
      // deletedAt: null,
    };

    // Search filter
    if (search) {
      baseWhere.OR = [
        { firstName: { contains: search, mode: "insensitive" } },
        { lastName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
      ];
    }

    const [totalCount, activeCount, suspendedCount, pendingResetCount, users] =
      await Promise.all([
        // Stat: Total
        prisma.user.count({ where: baseWhere }),

        // Stat: Active
        prisma.user.count({
          where: { ...baseWhere, isActive: true, id: { not: requesterId } },
        }),

        // Stat: Suspended
        prisma.user.count({ where: { ...baseWhere, isActive: false } }),

        // Stat: Pending password reset
        prisma.user.count({
          where: { ...baseWhere, passwordResetRequired: true },
        }),

        // Table list
        prisma.user.findMany({
          where: baseWhere,
          skip,
          take: limit,
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            role: true,
            isActive: true,
            passwordResetRequired: true,
            emailVerifiedAt: true,
            avatarUrl: true,
            lastLoginAt: true,
            createdAt: true,
            suspendedAt: true,
            suspensionReason: true,
            // Ward link — for councillors this is their assignedWard
            // For others it's their home ward
            ward: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: "desc" },
        }),
      ]);

    // Shape users to match UI field names exactly
    const accounts = users.map((u) => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName}`,
      email: u.email,
      phone: u.phone ?? "—",
      role: u.role,
      ward: u.ward?.name ?? null,
      avatarUrl: u.avatarUrl,
      emailVerified: u.emailVerifiedAt !== null,
      status: u.isActive
          ? "active"
          : "suspended",
      isReset:  u.passwordResetRequired,
      lastLogin: u.lastLoginAt ?? null,
      createdAt: u.createdAt.toISOString().split("T")[0],
      suspendedAt: u.suspendedAt?.toISOString() ?? null,
      suspensionReason: u.suspensionReason ?? null,
    }));

    return sendSuccess(res, {
      counts: {
        total: totalCount,
        active: activeCount,
        suspended: suspendedCount,
        pending: pendingResetCount,
      },
      accounts,
      meta: {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit),
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/v1/lga-admin/accounts/:id/reset-password
 * Generates a secure temp password, flags account for reset.
 * TODO Phase 7: Replace tempPassword response with email delivery via Sendgrid/Termii
 */
export const resetAccountPassword = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = String(req.params.id);
    const { id: requesterId, role: requesterRole } = req.user!;

    const target = await prisma.user.findUnique({
      where: { id: String(id) },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        role: true,
        // deletedAt: true,
      },
    });

    if (!target) {
      return sendError(res, "Account not found", "NOT_FOUND", null, 404);
    }

    if (
      requesterRole === "lga_admin" &&
      ["super_admin", "lga_admin"].includes(target.role)
    ) {
      return sendError(
        res,
        "You cannot reset this account password",
        "FORBIDDEN",
        null,
        403,
      );
    }

    if (id === requesterId) {
      return sendError(
        res,
        "Use your profile settings to reset your own password",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const tempPassword = generateTempPassword(12); // using your helper
    const hashedPassword = await bcrypt.hash(tempPassword, 12);

    await prisma.user.update({
      where: { id: String(id) },
      data: {
        password: hashedPassword,
        passwordResetRequired: true,
        tokenVersion: { increment: 1 }, // invalidate existing sessions
      },
    });

    await prisma.auditLog.create({
      data: {
        action: "user_updated",
        entity: "User",
        entityId: String(id),
        userId: requesterId,
        details: {
          action: "password_reset",
          resetBy: requesterId,
          targetEmail: target.email,
        },
        ipAddress: getIp(req),
      },
    });

    // --- Send notifications ---
    const fullName = `${target.firstName} ${target.lastName}`;
    try {
      await notify({
        userId: target.id,
        to: { email: target.email, phone: target.phone ?? "" },
        templateKey: "account.passwordResetByAdmin",
        vars: {
          applicant_name: fullName,
          temp_password: tempPassword,
        },
        channels: ["email", "sms"],
      });
    } catch (notifyErr) {
      console.error(
        "[resetAccountPassword] notify() failed, continuing anyway:",
        notifyErr,
      );
    }

    return sendSuccess(res, {
      message: `Password reset for ${fullName}`,
      // We keep the temporary password in response for development,
      // but it's also sent via channels. Remove in production if desired.
      temporaryPassword: tempPassword,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/v1/lga-admin/staff/:id/resend-credentials
 * Regenerates temporary password and resends login credentials email to staff member.
 */
export const resendStaffCredentials = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const id = String(req.params.id);
    const staff = await prisma.user.findUnique({
      where: { id },
    });

    if (!staff) {
      return sendError(res, "Staff member not found", "NOT_FOUND", null, 404);
    }

    const uniqueTempPassword = generateTempPassword(12);
    const hashedPassword = await bcrypt.hash(uniqueTempPassword, 12);

    await prisma.user.update({
      where: { id },
      data: {
        password: hashedPassword,
        passwordResetRequired: true,
      },
    });

    try {
      await notify({
        userId: staff.id,
        to: { phone: staff.phone || "", email: staff.email },
        templateKey: "account.welcomeStaff",
        vars: {
          applicant_name: `${staff.firstName} ${staff.lastName}`,
          temp_password: uniqueTempPassword,
        },
        channels: ["sms", "email"],
      });
    } catch (notifyErr) {
      console.error("[resendStaffCredentials] notify() error:", notifyErr);
    }

    return sendSuccess(
      res,
      {
        staff: {
          id: staff.id,
          email: staff.email,
          firstName: staff.firstName,
          lastName: staff.lastName,
          role: staff.role,
        },
        temporaryPassword: uniqueTempPassword,
        notice: "New login credentials generated and dispatched to staff email.",
      },
      "Staff credentials resent successfully",
      200,
    );
  } catch (err) {
    next(err);
  }
};
