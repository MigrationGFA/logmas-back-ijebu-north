// auth.controller.ts
import { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "../../utils/prisma";
import { generateAccessToken, generateRefreshToken } from "../../utils/jwt";
import { sendSuccess, sendError } from "../../utils/response";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import env from "../../config/env";
import { notify } from "../notification/notification.service";
import { getIp } from "../complaints/complaints.controller";

export const register = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { email, password, firstName, lastName, role } = req.body;

    // Only citizens and business owners can self-register
    const allowedSelfRegisterRoles = ["citizen", "business_owner"];

    const assignedRole =
      role && allowedSelfRegisterRoles.includes(role) ? role : "citizen";

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return sendError(res, "Email already registered", "CONFLICT", null, 409);
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const verificationToken = crypto.randomBytes(32).toString("hex");

    const verificationExpiresAt = new Date(
      Date.now() + 30 * 60 * 1000, // 30 minutes
    );

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        firstName,
        lastName,
        role: assignedRole,

        isActive: true,

        emailVerificationToken: verificationToken,
        emailVerificationTokenExpiresAt: verificationExpiresAt,
      },
    });
    
    const verificationLink = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;

    await prisma.auditLog.create({
      data: {
        action: "user_created",
        userId: user.id,
        entity: "User",
        entityId: user.id,
        details: {
          role: assignedRole,
          emailVerificationRequired: true,
        },
        ipAddress: req.ip,
      },
    });

    try {
      await notify({
        userId: user.id,
        to: {
          email: user.email,
        },
        templateKey: "account.verifyEmail",
        vars: {
          applicant_name: `${user.firstName} ${user.lastName}`,
          verification_link: verificationLink,
          expiration_time: "30 minutes",
        },
        channels: ["email"],
      });
    } catch (notifyErr) {
      console.error(
        "[forgotPassword] notify() failed, continuing anyway:",
        notifyErr,
      );
    }

    const { password: _, ...userResponse } = user;

    return sendSuccess(
      res,
      {
        user: userResponse,
        emailVerificationRequired: true,
      },
      "Account created. Please verify your email before signing in.",
      201,
    );
  } catch (err) {
    next(err);
  }
};

export const login = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findFirst({
      where: { email },
    });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return sendError(
        res,
        "Invalid credentials provided",
        "UNAUTHORIZED",
        null,
        401,
      );
    }

    // Check if account is suspended
    if (!user.isActive) {
      return sendError(
        res,
        "Account suspended. Contact LGA Secretariat.",
        "SUSPENDED",
        null,
        403,
      );
    }

    if(!user.emailVerifiedAt &&( user.role === "citizen" || user.role === "business_owner")) {
      return sendError(
        res,
        "Email not verified. Please verify your email before signing in.",
        "UNAUTHORIZED",
        null,
        401,
      );
    }

    // Get fresh tokenVersion
    const tokenVersion = user.tokenVersion;

    const accessToken = generateAccessToken({
      id: user.id,
      role: user.role,
      email: user.email,
      wardId: user.wardId,
      tokenVersion,
    });
    const refreshToken = generateRefreshToken({ id: user.id });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return sendSuccess(res, {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        emailVerifiedAt:user.emailVerifiedAt,
        onboardingCompleted: user.onboardingCompleted,
        isActive: user.isActive,
        notifyByInApp: user.notifyByInApp,
        // passwordResetRequired: user.passwordResetRequired, // NEW
      },
    });
  } catch (err) {
    next(err);
  }
};

export const getMe = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user?.id },
      include: { ward: { select: { id: true, name: true } } },
    });
    if (!user)
      return sendError(
        res,
        "User record profile could not be localized",
        "NOT_FOUND",
        null,
        404,
      );
    const { password: _, ...userResponse } = user;
    return sendSuccess(res, userResponse);
  } catch (err) {
    next(err);
  }
};

/**
 * NEW: Google Authentication Endpoint Controller
 * Decodes the frontend client's validated payload credentials tokens.
 */
// auth.controller.ts
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export const googleLogin = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { token } = req.body;

    // Actually verify the token with Google
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return sendError(res, "Invalid Google token", "BAD_REQUEST", null, 400);
    }

    if (!payload.email_verified) {
      return sendError(
        res,
        "Google email not verified",
        "UNAUTHORIZED",
        null,
        401,
      );
    }

    const email = payload.email.toLowerCase();
    const firstName = payload.given_name || "Citizen";
    const lastName = payload.family_name || "User";

    let user = await prisma.user.findFirst({
      where: { email, deletedAt: null },
    });

    if (!user) {
      const fallbackPassword = await bcrypt.hash(crypto.randomUUID(), 12);
      user = await prisma.user.create({
        data: {
          email,
          firstName,
          lastName,
          password: fallbackPassword,
          role: "citizen",
        },
      });
    }

    const accessToken = generateAccessToken({
      id: user.id,
      role: user.role,
      email: user.email,
      // wardId: user.wardId,
      tokenVersion: user.tokenVersion, // NEW
    });
    const refreshToken = generateRefreshToken({ id: user.id });

    return sendSuccess(res, {
      accessToken,
      refreshToken,
      role: user.role,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  } catch (err) {
    next(err);
  }
};

// auth.controller.ts
export const refreshToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken)
      return sendError(res, "Refresh token required", "BAD_REQUEST", null, 400);

    const decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as {
      id: string;
    };
    const user = await prisma.user.findUnique({ where: { id: decoded.id } });

    if (!user || !user.isActive) {
      return sendError(res, "Invalid refresh token", "UNAUTHORIZED", null, 401);
    }

    const accessToken = generateAccessToken({
      id: user.id,
      role: user.role,
      email: user.email,
      tokenVersion: user.tokenVersion, // NEW
    });
    return sendSuccess(res, { accessToken });
  } catch (err) {
    return sendError(
      res,
      "Invalid or expired refresh token",
      "UNAUTHORIZED",
      null,
      401,
    );
  }
};

export const updateUserProfile = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    // 1. Ensure the session contains a valid user context
    if (!req.user || !req.user.id) {
      return sendError(
        res,
        "Unauthorized context binding",
        "UNAUTHORIZED",
        null,
        401,
      );
    }

    const userId = req.user.id;
    const {
      // Common fields
      firstName,
      lastName,
      phone,
      email,
      address,
      town,
      ward,
      dateOfBirth,
      gender,
      emergencyContact,
      avatarUrl,
      passportPhoto,
      
      // Citizen fields
      occupation,
      identificationType,
      identificationNumber,
      nin,
      
      // Business fields
      businessName,
      businessType,
      cacNumber,
      taxIdNumber,
      ownerRepresentative,
      
      // Onboarding status
      onboardingCompleted,
      
      // Notification preferences
      notifyByEmail,
      notifyBySms,
      notifyByInApp,
    } = req.body;

    // 2. Input validation - define allowed fields and their types
    const stringFields = {
      firstName,
      lastName,
      phone,
      email,
      address,
      town,
      ward,
      gender,
      emergencyContact,
      avatarUrl,
      passportPhoto,
      occupation,
      identificationType,
      identificationNumber,
      nin,
      businessName,
      businessType,
      cacNumber,
      taxIdNumber,
      ownerRepresentative,
    };

    // Validate string fields
    for (const [key, value] of Object.entries(stringFields)) {
      if (value !== undefined && value !== null && typeof value !== "string") {
        return sendError(
          res,
          `${key} must be a valid string`,
          "BAD_REQUEST",
          null,
          400,
        );
      }
    }

    // Validate boolean fields
    const booleanFields = {
      onboardingCompleted,
      notifyByEmail,
      notifyBySms,
      notifyByInApp,
    };

    for (const [key, value] of Object.entries(booleanFields)) {
      if (value !== undefined && typeof value !== "boolean") {
        return sendError(
          res,
          `${key} must be a boolean value`,
          "BAD_REQUEST",
          null,
          400,
        );
      }
    }

    // Validate date field
    // if (dateOfBirth !== undefined) {
    //   const date = new Date(dateOfBirth);
    //   if (isNaN(date.getTime())) {
    //     return sendError(
    //       res,
    //       "dateOfBirth must be a valid date",
    //       "BAD_REQUEST",
    //       null,
    //       400,
    //     );
    //   }
    // }

    // 3. Duplicate phone number check
    if (phone && phone.trim() !== "") {
      const trimmedPhone = phone.trim();

      const duplicatePhone = await prisma.user.findFirst({
        where: {
          phone: trimmedPhone,
          id: { not: userId },
          NOT: {
            OR: [{ phone: null }, { phone: "" }],
          },
        },
      });

      if (duplicatePhone) {
        return sendError(
          res,
          "This phone number is already registered to another account",
          "CONFLICT",
          null,
          409,
        );
      }
    }

    // 4. Duplicate NIN check (for citizens)
    if (nin && nin.trim() !== "") {
      const trimmedNin = nin.trim();

      const duplicateNin = await prisma.user.findFirst({
        where: {
          nin: trimmedNin,
          id: { not: userId },
          NOT: {
            OR: [{ nin: null }, { nin: "" }],
          },
        },
      });

      if (duplicateNin) {
        return sendError(
          res,
          "This NIN is already registered to another account",
          "CONFLICT",
          null,
          409,
        );
      }
    }

    // 5. Duplicate CAC check (for businesses)
    if (cacNumber && cacNumber.trim() !== "") {
      const trimmedCac = cacNumber.trim();

      const duplicateCac = await prisma.user.findFirst({
        where: {
          cacNumber: trimmedCac,
          id: { not: userId },
          NOT: {
            OR: [{ cacNumber: null }, { cacNumber: "" }],
          },
        },
      });

      if (duplicateCac) {
        return sendError(
          res,
          "This CAC registration number is already registered to another account",
          "CONFLICT",
          null,
          409,
        );
      }
    }

    // 6. Prepare update data
    const updateData: any = {};

    // Helper function to add string fields if provided
    const addStringField = (key: string, value: any, trim: boolean = true) => {
      if (value !== undefined) {
        updateData[key] = value && trim ? value.trim() : value;
      }
    };

    // Helper function to add boolean fields if provided
    const addBooleanField = (key: string, value: any) => {
      if (value !== undefined) {
        updateData[key] = value;
      }
    };

    // Add all string fields
    addStringField("firstName", firstName);
    addStringField("lastName", lastName);
    
    // Handle phone specially (can be null)
    if (phone !== undefined) {
      updateData.phone = phone === null || phone === "" ? null : phone.trim();
    }


    // Only include avatarUrl when the frontend actually sends it.
    // This avoids crashes when the field is omitted and preserves null/empty as clearable values.
    if (avatarUrl !== undefined) {
      updateData.avatarUrl = avatarUrl === null || avatarUrl === "" ? null : avatarUrl.trim();
    }
    
    // Email is usually not updated here, but include if provided
    addStringField("email", email);
    
    addStringField("address", address);
    addStringField("town", town);
    addStringField("dateOfBirth", dateOfBirth);
    // Ward arrives as a ward NAME from the profile forms, but the account
    // stores the ward relation, so resolve the name to the ward record.
    // An unknown name is ignored rather than failing the whole save, and
    // an empty value clears the ward.
    if (ward !== undefined) {
      if (ward) {
        const wardRecord = await prisma.ward.findFirst({
          where: { name: ward },
        });
        if (wardRecord) updateData.wardId = wardRecord.id;
      } else {
        updateData.wardId = null;
      }
    }
    addStringField("gender", gender);
    addStringField("emergencyContact", emergencyContact);
    // addStringField("avatarUrl", avatarUrl);
    addStringField("passportPhoto", passportPhoto);
    
    // Citizen fields
    addStringField("occupation", occupation);
    addStringField("identificationType", identificationType);
    addStringField("identificationNumber", identificationNumber);
    addStringField("nin", nin);
    
    // Business fields
    addStringField("businessName", businessName);
    addStringField("businessType", businessType);
    addStringField("cacNumber", cacNumber);
    addStringField("taxIdNumber", taxIdNumber);
    addStringField("ownerRepresentative", ownerRepresentative);
    
    // Date field
    // if (dateOfBirth !== undefined) {
    //   updateData.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : null;
    // }
    
    // Boolean fields
    addBooleanField("onboardingCompleted", onboardingCompleted);
    addBooleanField("notifyByEmail", notifyByEmail);
    addBooleanField("notifyBySms", notifyBySms);
    addBooleanField("notifyByInApp", notifyByInApp);

    // 7. Update user record
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      include: {
        // ward: true,
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });

    // 8. Remove sensitive fields before sending response
    const { password, ...userWithoutPassword } = updatedUser;

    // 9. Respond with the clean updated model profile
    return sendSuccess(
      res,
      userWithoutPassword,
      "Profile updated successfully",
    );
  } catch (err) {
    next(err);
  }
};

// src/auth/password.controller.ts
//
// TODO: fix import paths (prisma, sendSuccess/sendError, notify) to match your project

const RESET_TOKEN_TTL_MINUTES = 30;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// POST /api/v1/auth/forgot-password
// body: { email }
export const forgotPassword = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { email } = req.body;
    if (!email)
      return sendError(res, "Email is required", "BAD_REQUEST", null, 400);

    const user = await prisma.user.findUnique({ where: { email } });
    // Per your spec: the account must exist — explicit error if not, not the usual
    // "always say success" security pattern. Worth knowing this lets someone probe
    // which emails have accounts; acceptable tradeoff if that's intentional here.
    if (!user) {
      return sendError(
        res,
        "No account found with that email",
        "NOT_FOUND",
        null,
        404,
      );
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(
      Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000,
    );

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: tokenHash,
        passwordResetTokenExpiresAt: expiresAt,
      },
    });

    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${rawToken}`; // TODO: confirm your frontend route

    try {
      await notify({
        userId: user.id,
        to: { email: user.email, phone: user.phone ?? undefined },
        templateKey: "account.passwordReset",
        vars: {
          reset_link: resetLink,
          expiration_time: `${RESET_TOKEN_TTL_MINUTES} minutes`,
        },
        channels: ["email"], // sms omitted — no sms variant on this template currently
      });
    } catch (notifyErr) {
      console.error(
        "[forgotPassword] notify() failed, continuing anyway:",
        notifyErr,
      );
    }

    return sendSuccess(res, {
      message: "Password reset link sent to your email",
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/v1/auth/reset-password
// body: { token, newPassword, confirmPassword }
export const resetPassword = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { token, newPassword, confirmPassword } = req.body;

    if (!token || !newPassword || !confirmPassword) {
      return sendError(
        res,
        "token, newPassword, and confirmPassword are required",
        "BAD_REQUEST",
        null,
        400,
      );
    }
    if (newPassword !== confirmPassword) {
      return sendError(res, "Passwords do not match", "BAD_REQUEST", null, 400);
    }
    if (newPassword.length < 8) {
      return sendError(
        res,
        "Password must be at least 8 characters",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const tokenHash = hashToken(token);
    const user = await prisma.user.findUnique({
      where: { passwordResetToken: tokenHash },
    });

    if (
      !user ||
      !user.passwordResetTokenExpiresAt ||
      user.passwordResetTokenExpiresAt < new Date()
    ) {
      return sendError(
        res,
        "Reset link is invalid or has expired",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        passwordResetToken: null,
        passwordResetTokenExpiresAt: null,
        passwordResetRequired: false,
      },
    });

    await prisma.auditLog.create({
      data: {
        action: "user_updated",
        entity: "User",
        entityId: user.id,
        userId: user.id,
        details: { action: "password_reset_via_link" },
        ipAddress: getIp(req), // TODO: confirm this util exists in this file's scope
      },
    });

    try {
      await notify({
        userId: user.id,
        to: { email: user.email, phone: user.phone ?? undefined },
        templateKey: "account.passwordChanged",
        vars: { applicant_name: user.firstName },
        channels: ["email", "sms"],
      });
    } catch (notifyErr) {
      console.error(
        "[resetPassword] notify() failed, continuing anyway:",
        notifyErr,
      );
    }

    return sendSuccess(res, {
      message: "Password has been reset successfully. You can now log in.",
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/v1/auth/change-password
// Requires auth. body: { oldPassword, newPassword, confirmPassword }
export const changePassword = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user!.id;
    const { oldPassword, newPassword, confirmPassword } = req.body;

    if (!oldPassword || !newPassword || !confirmPassword) {
      return sendError(
        res,
        "oldPassword, newPassword, and confirmPassword are required",
        "BAD_REQUEST",
        null,
        400,
      );
    }
    if (newPassword !== confirmPassword) {
      return sendError(
        res,
        "New passwords do not match",
        "BAD_REQUEST",
        null,
        400,
      );
    }
    if (newPassword.length < 8) {
      return sendError(
        res,
        "Password must be at least 8 characters",
        "BAD_REQUEST",
        null,
        400,
      );
    }
    if (oldPassword === newPassword) {
      return sendError(
        res,
        "New password must be different from current password",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return sendError(res, "User not found", "NOT_FOUND", null, 404);

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return sendError(
        res,
        "Current password is incorrect",
        "BAD_REQUEST",
        null,
        400,
      );
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        passwordResetRequired: false,
        tokenVersion: { increment: 1 },
      },
    });

    const newToken = generateAccessToken({
      id: userId,
      role: req.user!.role,
      email: req.user!.email,
      wardId: req.user!.wardId,
      tokenVersion: (await prisma.user.findUnique({
        where: { id: userId },
        select: { tokenVersion: true },
      }))!.tokenVersion,
    });

    await prisma.auditLog.create({
      data: {
        action: "user_updated",
        entity: "User",
        entityId: userId,
        userId,
        details: { action: "password_changed" },
        ipAddress: getIp(req),
      },
    });

    try {
      await notify({
        userId: user.id,
        to: { email: user.email, phone: user.phone ?? undefined },
        templateKey: "account.passwordChanged",
        vars: { applicant_name: user.firstName },
        channels: ["email", "sms"],
      });
    } catch (notifyErr) {
      console.error(
        "[changePassword] notify() failed, continuing anyway:",
        notifyErr,
      );
    }

    return sendSuccess(res, {
      message: "Password changed successfully",
      accessToken: newToken,
    });
  } catch (err) {
    next(err);
  }
};

export const verifyEmail = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { token } = req.query;

    if (!token || typeof token !== "string") {
      return sendError(
        res,
        "Invalid verification link",
        "INVALID_TOKEN",
        null,
        400,
      );
    }

    const user = await prisma.user.findUnique({
      where: {
        emailVerificationToken: token,
      },
    });

    if (!user) {
      return sendError(
        res,
        "Invalid or expired verification link",
        "INVALID_TOKEN",
        null,
        400,
      );
    }

    if (
      user.emailVerificationTokenExpiresAt &&
      user.emailVerificationTokenExpiresAt < new Date()
    ) {
      return sendError(
        res,
        "Verification link has expired",
        "TOKEN_EXPIRED",
        null,
        400,
      );
    }

    if (user.emailVerifiedAt) {
      return sendSuccess(res, {
        message: "Email already verified",
      });
    }

    await prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        emailVerifiedAt: new Date(),
        emailVerificationToken: null,
        emailVerificationTokenExpiresAt: null,
      },
    });

    return sendSuccess(res, {
      message: "Email verified successfully",
    });
  } catch (error) {
    next(error);
  }
};

export const resendVerificationEmail = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { email } = req.body;

    const user = await prisma.user.findUnique({
      where: { email },
    });

    // Don't reveal whether the email exists.
    if (!user) {
      return sendSuccess(res, {
        message:
          "If an account exists with this email, a verification link has been sent.",
      });
    }

    // Already verified
    if (user.emailVerifiedAt) {
      return sendSuccess(res, {
        message: "This email address has already been verified.",
      });
    }

    const verificationToken = crypto.randomBytes(32).toString("hex");

    const verificationExpiresAt = new Date(
      Date.now() + 30 * 60 * 1000,
    );

    await prisma.user.update({
      where: {
        id: user.id,
      },
      data: {
        emailVerificationToken: verificationToken,
        emailVerificationTokenExpiresAt: verificationExpiresAt,
      },
    });

    const verificationLink =
      `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;

    try {
      await notify({
        userId: user.id,
        to: {
          email: user.email,
        },
        templateKey: "account.resendVerificationEmail",
        vars: {
          applicant_name: `${user.firstName} ${user.lastName}`,
          verification_link: verificationLink,
          expiration_time: "30 minutes",
        },
        channels: ["email"],
      });
    } catch (notifyErr) {
      console.error(
        "[resendVerificationEmail] notify() failed:",
        notifyErr,
      );

      return sendError(
        res,
        "Unable to send verification email. Please try again later.",
        "EMAIL_SEND_FAILED",
        null,
        500,
      );
    }

    return sendSuccess(res, {
      message:
        "If an account exists with this email, a verification link has been sent.",
    });
  } catch (err) {
    next(err);
  }
};