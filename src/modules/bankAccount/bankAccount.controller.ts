import { Request, Response, NextFunction } from "express";
import { sendSuccess, sendError } from "../../utils/response";
import { prisma } from "../../utils/prisma";
import { Role } from "@prisma/client";

/**
 * The LGA collection bank account (FO-only services).
 *
 * One account by design: the first (and only) row of lga_bank_accounts
 * is the account every FO collection is paid into. It lives in the
 * database so no account number is ever written into code. Staff can
 * read it (the FO invoice page shows it to the payer); only treasurer,
 * lga_admin and super_admin can save it, from dashboard Settings.
 */

const READ_ROLES: Role[] = [
  "field_officer",
  "treasurer",
  "lga_admin",
  "super_admin",
  "sub_admin",
  "auditor",
  "chairman",
];

const MANAGE_ROLES: Role[] = ["treasurer", "lga_admin", "super_admin"];

export const getBankAccount = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const role = req.user!.role as Role;
    if (!READ_ROLES.includes(role)) {
      return sendError(
        res,
        "You do not have access to the collection account",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const bankAccount = await prisma.lgaBankAccount.findFirst({
      orderBy: { createdAt: "asc" },
    });

    return sendSuccess(res, { bankAccount });
  } catch (err) {
    next(err);
  }
};

export const upsertBankAccount = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const role = req.user!.role as Role;
    if (!MANAGE_ROLES.includes(role)) {
      return sendError(
        res,
        "Only the treasurer or an admin can manage the collection account",
        "FORBIDDEN",
        null,
        403,
      );
    }

    const { bankName, accountName, accountNumber } = req.body || {};
    const clean = {
      bankName: typeof bankName === "string" ? bankName.trim() : "",
      accountName: typeof accountName === "string" ? accountName.trim() : "",
      accountNumber:
        typeof accountNumber === "string" ? accountNumber.trim() : "",
    };
    if (!clean.bankName || !clean.accountName || !clean.accountNumber) {
      return sendError(
        res,
        "Bank name, account name and account number are all required",
        "VALIDATION_ERROR",
        null,
        400,
      );
    }

    const existing = await prisma.lgaBankAccount.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    const bankAccount = existing
      ? await prisma.lgaBankAccount.update({
          where: { id: existing.id },
          data: { ...clean, updatedById: req.user!.id },
        })
      : await prisma.lgaBankAccount.create({
          data: { ...clean, updatedById: req.user!.id },
        });

    await prisma.auditLog.create({
      data: {
        action: "bank_account_updated",
        entity: "LgaBankAccount",
        entityId: bankAccount.id,
        userId: req.user!.id,
        details: {
          bankName: bankAccount.bankName,
          accountName: bankAccount.accountName,
        } as any,
      },
    });

    return sendSuccess(
      res,
      { bankAccount },
      "Collection bank account saved.",
    );
  } catch (err) {
    next(err);
  }
};
