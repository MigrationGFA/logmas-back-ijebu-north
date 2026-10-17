// src/modules/treasurer/treasurer.validation.ts
import { z } from "zod";

// ── Levy Config ───────────────────────────────────────────────

export const createLevyConfigSchema = z.object({
  name: z.string().min(2, "Config name is required"),
  categoryId: z.string().uuid("Invalid Category ID format. Must be a valid UUID reference."),
  description: z.string().optional(),
  amount: z.number().positive("Amount must be positive"),
  billingCycle: z
    .enum(["one_time", "daily", "weekly", "monthly", "yearly"])
    .default("yearly"),
  mode: z
    .enum(["fixed", "variable",])
    .default("fixed"),
  penaltyRate: z.number().min(0).max(100).optional(), // percentage
  effectiveFrom: z
    .string()
    .or(z.literal(""))
    .transform((v) => (v === "" ? undefined : v))
    .refine((v) => !v || !isNaN(Date.parse(v)), {
      message: "Invalid effectiveFrom date",
    })
    .optional(),

  effectiveTo: z
    .string()
    .or(z.literal(""))
    .transform((v) => (v === "" ? undefined : v))
    .refine((v) => !v || !isNaN(Date.parse(v)), {
      message: "Invalid effectiveTo date",
    })
    .optional(),
});

export const updateLevyConfigSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().optional(),
  amount: z.number().positive().optional(),
  billingCycle: z
    .enum(["one_time", "daily", "weekly", "monthly", "yearly"])
    .optional(),
  penaltyRate: z.number().min(0).max(100).optional(),
  effectiveTo: z
    .string()
    .or(z.literal(""))
    .transform((v) => (v === "" ? undefined : v))
    .refine((v) => !v || !isNaN(Date.parse(v)), {
      message: "Invalid effectiveTo date",
    })
    .optional(),
});

export const listLevyConfigsSchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => parseInt(v || "1")),
  limit: z
    .string()
    .optional()
    .transform((v) => parseInt(v || "10")),
  category: z
    .enum([
      "trade_permit",
      "market_levy",
      "environmental_levy",
      "signage",
      "parking_levy",
      "haulage_levy",
      "lockup_store_levy",
      "business_levy",
      "event_permit",
      "state_of_origin_fee",
      "other",
    ])
    .optional(),
  isActive: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

// ── Revenue & Reporting ───────────────────────────────────────

export const dateRangeSchema = z.object({
  from: z
    .string()
    .refine((v) => !isNaN(Date.parse(v)), { message: "Invalid from date" })
    .optional(),
  to: z
    .string()
    .refine((v) => !isNaN(Date.parse(v)), { message: "Invalid to date" })
    .optional(),
  page: z
    .string()
    .optional()
    .transform((v) => parseInt(v || "1")),
  limit: z
    .string()
    .optional()
    .transform((v) => parseInt(v || "10")),
});

export const invoiceFilterSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  status: z
    .enum(["draft", "sent", "paid", "overdue", "cancelled", "partially_paid"])
    .optional(),
  category: z
    .enum([
      "trade_permit",
      "market_levy",
      "environmental_levy",
      "signage",
      "parking_levy",
      "haulage_levy",
      "lockup_store_levy",
      "business_levy",
      "event_permit",
      "state_of_origin_fee",
      "other",
    ])
    .optional(),
  officerId: z.string().uuid().optional(),
  businessId: z.string().uuid().optional(),
  page: z
    .string()
    .optional()
    .transform((v) => parseInt(v || "1")),
  limit: z
    .string()
    .optional()
    .transform((v) => parseInt(v || "10")),
});

export const listPermitConfigsSchema = z.object({
  query: z.object({
    categoryId: z.string(),
    isActive: z
      .string()
      .transform((val) => val === "true")
      .optional(),
    page: z
      .string()
      .optional()
      .transform((val) => (val ? parseInt(val, 10) : 1)),
    limit: z
      .string()
      .optional()
      .transform((val) => (val ? parseInt(val, 10) : 20)),
  }),
});

export const createPermitConfigSchema = z.object({
  body: z.object({
    name: z.string().min(3, "Name must be at least 3 characters long"),
    code: z
      .string()
      .min(3, "System identifier code must be at least 3 characters")
      .max(20),
    categoryId: z.string(),
    baseAmount: z
      .number()
      .nonnegative("Base pricing configuration rate cannot be negative"),
  }),
});

export const updatePermitConfigSchema = z.object({
  body: z.object({
    name: z.string().min(3).optional(),
    baseAmount: z.number().nonnegative().optional(),
    isActive: z.boolean().optional(),
  }),
});

// ── Treasurer Fees (LGA simplified flow)
export const upsertServiceFeeSchema = z.object({
  amount: z.number().positive('Amount must be a positive monetary value'),
  status: z.boolean().optional().default(true) // true = ACTIVE, false = INACTIVE
});

// ── Static-account payment confirmation ───────────────────────
export const declinePaymentSchema = z.object({
  reason: z.string().min(3, 'A decline reason is required'),
});
