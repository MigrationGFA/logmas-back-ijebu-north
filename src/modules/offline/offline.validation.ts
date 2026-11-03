// offline.validation.ts
//
// Runtime validation for the offline sync payload, at the trust boundary.
// The shape mirrors what the field officer app stores in its on-device queue
// (see the frontend src/lib/offline module). Form types are NOT validated
// against a hardcoded list: formType is the service code, and the sync
// service checks it against the services table, so a cloned LGA with
// different services needs no code change here.
import { z } from "zod";

export const offlineFileSchema = z.object({
  documentType: z.string().min(1).optional(),
  originalName: z.string().min(1),
  fileName: z.string().min(1),
  url: z.string().min(1),
  mimeType: z.string().optional(),
  fileSize: z.number().int().nonnegative().optional(),
});

export const offlineApplicantSchema = z.object({
  // An existing citizen, resolved on the device before capture when the
  // citizen was already known.
  applicantId: z.string().min(1).optional(),
  // Or the details to register a new citizen on sync, exactly as the field
  // officer captured them.
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(7).optional(),
});

export const offlineEditEntrySchema = z.object({
  field: z.string().min(1),
  oldValue: z.unknown(),
  newValue: z.unknown(),
  editedAt: z.string().min(1),
});

export const syncOfflineRecordSchema = z.object({
  // Generated on the device when the record is captured. The server treats
  // it as the idempotency key for the whole sync.
  clientRecordId: z.string().min(8),
  recordType: z.enum(["application", "violation"]).default("application"),
  // For applications: the service id (preferred) or its code.
  serviceId: z.string().min(1).optional(),
  serviceCode: z.string().min(1).optional(),
  formData: z.record(z.string(), z.unknown()),
  applicant: offlineApplicantSchema.optional(),
  files: z.array(offlineFileSchema).default([]),
  editHistory: z.array(offlineEditEntrySchema).default([]),
  // When the record was captured on the device. May be hours before the
  // sync request reaches the server.
  capturedAt: z.string().min(1),
  source: z
    .enum(["web", "mobile", "field_officer", "manual"])
    .default("field_officer"),
});

export type SyncOfflineRecordInput = z.infer<typeof syncOfflineRecordSchema>;
export type OfflineFileInput = z.infer<typeof offlineFileSchema>;
