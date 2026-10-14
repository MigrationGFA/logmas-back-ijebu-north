// src/modules/fieldOfficer/fieldOfficer.validation.ts
import { z } from 'zod';

// ── Business Registration ─────────────────────────────────────

export const registerBusinessSchema = z.object({
  businessName: z.string().min(2, 'Business name is required'),
  ownerName: z.string().min(2, 'Owner name is required'),
  address: z.string().min(5, 'Business address is required'),
  phone: z.string().min(10, 'Valid phone number is required'),
  email: z.string().optional(),
  cacNumber: z.string().optional(),
  category: z.string().min(2, 'Business category is required'),
  description: z.string().optional(),
  // wardId: z.string().uuid('Invalid ward ID'),
});

// ── Invoice Generation ────────────────────────────────────────

export const generateInvoiceSchema = z.object({
  // ── 1. Business Details ──────────────────────────────────────
  // Either provide an existing businessId OR the details to create a new one
  businessId: z.string().uuid('Invalid business ID').optional(),
  
  // New business fields (Conditionally required if businessId is omitted)
  businessName: z.string().min(1, 'Business name is required').optional(),
  ownerName: z.string().min(1, 'Owner name is required').optional(),
  phone: z.string().min(1, 'Phone number is required').optional(),
  // wardId: z.string().uuid('Invalid ward ID').optional(),
  
  // Optional new business fields
  email: z.string().email('Invalid email format').optional().or(z.literal('')),
  address: z.string().optional(),
  category: z.string().optional(), // Maps to `businessCategory` in the controller

  // ── 2. Invoice Details ───────────────────────────────────────
  categoryId: z.string().uuid('Invalid revenue category ID'),
  levyConfigId: z.string().uuid('Invalid levy config ID').optional(),
  description: z.string().optional(),
  
  // ── 3. Pricing & Quantity ────────────────────────────────────
  // Officer can override amount if no levy config exists
  overrideAmount: z.number().positive('Override amount must be a positive number').optional(),
  quantity: z.number().int().positive('Quantity must be a positive integer').default(1),
  
  // ── 4. Due Date ──────────────────────────────────────────────
  dueDate: z.union([z.string(), z.date()]).optional(),

})

// ── Payment Recording ─────────────────────────────────────────

export const recordPaymentSchema = z.object({
  invoiceId: z.string().uuid('Invalid invoice ID'),
  amount: z.number().positive('Amount must be positive'),
  method: z.enum(['cash', 'pos', 'bank_transfer', 'virtual_account', 'online_gateway']),
  reference: z.string().optional(), // POS slip, transfer ref etc.
  narration: z.string().optional(),
});

// ── Permit Issuance ───────────────────────────────────────────

export const issuePermitSchema = z.object({
  invoiceId: z.string().uuid('Invoice ID is required'),
  permitType: z.string().min(2, 'Permit type is required'),
  category: z.enum([
    'trade_permit',
    'market_levy',
    'environmental_levy',
    'signage',
    'parking_levy',
    'haulage_levy',
    'lockup_store_levy',
    'business_levy',
    'event_permit',
    'other',
  ]),
  businessId: z.string().uuid('Invalid business ID'),
  validFrom: z.string().refine((v) => !isNaN(Date.parse(v)), { message: 'Invalid date' }).optional(),
});

// ── Query Filters ─────────────────────────────────────────────

export const collectionsQuerySchema = z.object({
  page: z.string().optional().transform((v) => parseInt(v || '1')),
  limit: z.string().optional().transform((v) => parseInt(v || '10')),
  date: z.string().optional(), // filter by specific date YYYY-MM-DD
  category: z.enum([
    'trade_permit', 'market_levy', 'environmental_levy',
    'signage', 'parking_levy', 'haulage_levy',
    'lockup_store_levy', 'business_levy', 'event_permit',
    'state_of_origin_fee', 'other',
  ]).optional(),
});

// ── Static-account applications ───────────────────────────────

export const createStaticAccountApplicationSchema = z
  .object({
    serviceId: z.string().min(1, 'serviceId is required'),
    formData: z.record(z.string(), z.any()).optional(),
    applicantId: z.string().uuid('Invalid applicant ID').optional(),
    firstName: z.string().min(2, 'First name is required').optional(),
    lastName: z.string().min(2, 'Last name is required').optional(),
    email: z.string().email('Invalid email format').optional(),
    phone: z.string().min(7, 'Valid phone number is required').optional(),
  })
  .refine(
    (data) => Boolean(data.applicantId) || Boolean(data.firstName && data.lastName && data.email),
    {
      message:
        'Provide either an existing applicantId or firstName/lastName/email to register a new citizen',
      path: ['applicantId'],
    },
  );
