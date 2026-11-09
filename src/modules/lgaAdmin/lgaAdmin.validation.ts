// src/modules/lgaAdmin/lgaAdmin.validation.ts
import { z } from "zod";

// ── Ward Management ───────────────────────────────────────────

export const createWardSchema = z.object({
  name: z.string().min(2, "Ward name is required"),
  code: z.string().min(2, "Ward code is required"),
  description: z.string().optional(),
});

export const updateWardSchema = z.object({
  name: z.string().min(2).optional(),
  code: z.string().min(2).optional(),
  description: z.string().optional(),
});

export const assignCouncillorSchema = z.object({
  councillorId: z.string().uuid("Invalid councillor user ID"),
});

// ── Staff Creation ────────────────────────────────────────────

export const createStaffSchema = z
  .object({
    email: z.string().email("Valid email is required"),
    firstName: z.string().min(1, "First name is required"),
    lastName: z.string().min(1, "Last name is required"),
    phone: z.string().optional(),
    role: z.enum([
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
    ]),
    // wardId: z.string().optional(), // required when role = ward_councillor
    // contractorId: z.string().uuid().optional(), // required when role = field_officer or agent
  })
  // .refine(
  //   (data) => {
  //     if ((data.role === "ward_councillor" || data.role === "field_officer") && !data.wardId) return false;
  //     return true;
  //   },
  //   { message: "wardId is required when creating a ward councillor and field officer" },
  // );
// .refine((data) => {
//   if ((data.role === 'field_officer' || data.role === 'agent') && !data.contractorId) return false;
//   return true;
// }, { message: 'contractorId is required when creating a field officer or agent' });

export const updateStaffSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().optional(),
  isActive: z.boolean().optional(),
  wardId: z.string().uuid().optional(),
  contractorId: z.string().uuid().optional(),
});

// ── Query Filters ─────────────────────────────────────────────

export const listStaffSchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => parseInt(v || "1")),
  limit: z
    .string()
    .optional()
    .transform((v) => parseInt(v || "10")),
  role: z
    .enum([
      "sub_admin",
      "ward_councillor",
      "contractor",
      "field_officer",
      "agent",
      "lga_admin",
      "chairman",
      "treasurer",
      "auditor",
    ])
    .optional(),
  isActive: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  wardId: z.string().uuid().optional(),
});

export const listWardsSchema = z.object({
  page: z
    .string()
    .optional()
    .transform((v) => parseInt(v || "1")),
  limit: z
    .string()
    .optional()
    .transform((v) => parseInt(v || "10")),
});
