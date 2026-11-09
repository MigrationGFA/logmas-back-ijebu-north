// src/modules/lgaAdmin/lgaAdmin.routes.ts
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import { requireRole } from '../../middleware/authorize.middleware';
import { validateBody, validateQuery } from '../../middleware/validate.middleware';
import {
  createWard, listWards, getWardById, updateWard,
  assignCouncillor, deleteWard,
  createStaff,
  resendStaffCredentials, listStaff, getStaffById, updateStaff, toggleStaffStatus,
  getAdminOverview,
  getAccountsOverview,
  resetAccountPassword,

} from './lgaAdmin.controller';
import {
  createWardSchema, updateWardSchema, assignCouncillorSchema,
  createStaffSchema, updateStaffSchema,
  listStaffSchema, listWardsSchema,
} from './lgaAdmin.validation';

const router = Router();

// Both lga_admin and super_admin can access all these routes
const guard = [requireAuth, requireRole('lga_admin', 'super_admin', 'sub_admin')];

// ── OVERVIEW ──────────────────────────────────────────────────

/**
 * @openapi
 * /lga/overview:
 *   get:
 *     tags: [LGA Admin]
 *     summary: Dashboard overview — ward, staff, application and complaint stats
 *     security:
 *       - BearerAuth: []
 */
router.get('/overview', ...guard, getAdminOverview);

// ── WARDS ─────────────────────────────────────────────────────

/**
 * @openapi
 * /lga/wards:
 *   post:
 *     tags: [LGA Admin]
 *     summary: Create a new ward
 *     security:
 *       - BearerAuth: []
 */
router.post('/wards', ...guard, validateBody(createWardSchema), createWard);

/**
 * @openapi
 * /lga/wards:
 *   get:
 *     tags: [LGA Admin]
 *     summary: List all wards with councillor info and counts
 *     security:
 *       - BearerAuth: []
 */
router.get('/wards', ...guard, listWards);

/**
 * @openapi
 * /lga/wards/{id}:
 *   get:
 *     tags: [LGA Admin]
 *     summary: Get a single ward with full detail
 *     security:
 *       - BearerAuth: []
 */
router.get('/wards/:id', ...guard, getWardById);

/**
 * @openapi
 * /lga/wards/{id}:
 *   patch:
 *     tags: [LGA Admin]
 *     summary: Update ward details
 *     security:
 *       - BearerAuth: []
 */
router.patch('/wards/:id', ...guard, validateBody(updateWardSchema), updateWard);

/**
 * @openapi
 * /lga/wards/{id}/assign-councillor:
 *   patch:
 *     tags: [LGA Admin]
 *     summary: Assign a ward councillor to this ward
 *     security:
 *       - BearerAuth: []
 */
router.patch(
  '/wards/:id/assign-councillor',
  ...guard,
  validateBody(assignCouncillorSchema),
  assignCouncillor
);

/**
 * @openapi
 * /lga/wards/{id}:
 *   delete:
 *     tags: [LGA Admin]
 *     summary: Soft delete a ward
 *     security:
 *       - BearerAuth: []
 */
router.delete('/wards/:id', ...guard, deleteWard);

// ── STAFF ─────────────────────────────────────────────────────

/**
 * @openapi
 * /lga/staff:
 *   post:
 *     tags: [LGA Admin]
 *     summary: Create a new staff account with a generated temporary password
 *     security:
 *       - BearerAuth: []
 */
router.post('/staff', ...guard, validateBody(createStaffSchema), createStaff);
router.post('/staff/:id/resend-credentials', ...guard, resendStaffCredentials);
/**
 * @openapi
 * /lga/contractors:
 *   post:
 *     tags: [LGA Admin]
 *     summary: Create a new Contractor account with a generated temporary password
 *     security:
 *       - BearerAuth: []
 */
// router.post('/contractors', ...guard,  createContractor);
/**
 * @openapi
 * /lga/contractors/:contractorId/agents:
 *   post:
 *     tags: [LGA Admin]
 *     summary: Create a new Contractor account with a generated temporary password
 *     security:
 *       - BearerAuth: []
 */
// router.post('/contractors/:contractorId/agents', ...guard,  addAgentToContractor);

/**
 * @openapi
 * /lga/staff:
 *   get:
 *     tags: [LGA Admin]
 *     summary: List all staff — filterable by role, ward, and active status
 *     security:
 *       - BearerAuth: []
 */
router.get('/staff', ...guard, listStaff);

/**
 * @openapi
 * /lga/staff/{id}:
 *   get:
 *     tags: [LGA Admin]
 *     summary: Get a single staff member with full profile
 *     security:
 *       - BearerAuth: []
 */
router.get('/staff/:id', ...guard, getStaffById);

/**
 * @openapi
 * /lga/staff/{id}:
 *   patch:
 *     tags: [LGA Admin]
 *     summary: Update staff profile or reassign ward/contractor
 *     security:
 *       - BearerAuth: []
 */
router.patch('/staff/:id', ...guard, validateBody(updateStaffSchema), updateStaff);

/**
 * @openapi
 * /lga/staff/{id}/toggle-status:
 *   patch:
 *     tags: [LGA Admin]
 *     summary: Activate or suspend a staff account
 *     security:
 *       - BearerAuth: []
 */
router.patch('/staff/:id/toggle-status', ...guard, toggleStaffStatus);

/**
 * @openapi
 * /lga/accounts/overview:
 *   patch:
 *     tags: [LGA Admin]
 *     summary: Get All Accounts Overview
 *     security:
 *       - BearerAuth: []
 */
router.get('/accounts/overview', ...guard, getAccountsOverview);
/**
 * @openapi
 * /lga/contractors/overview:
 *   patch:
 *     tags: [LGA Admin]
 *     summary: Get All Contractors Overview
 *     security:
 *       - BearerAuth: []
 */
// router.get('/contractors/overview', ...guard, getContractorsOverview);

/**
 * @openapi
 * /lga/accounts/:id/reset-password:
 *   patch:
 *     tags: [LGA Admin]
 *     summary: Reset a Users password
 *     security:
 *       - BearerAuth: []
 */
router.patch('/accounts/:id/reset-password', ...guard, resetAccountPassword);

// router.get('/permits', ...guard, getAllPermits);

// router.patch('/permits/:id/revoke', ...guard, revokePermit);

export default router;