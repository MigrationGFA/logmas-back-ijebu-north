// offline.service.ts
//
// The server half of field officer offline capture.
//
// Design, in one paragraph: the queue lives on the officer's phone, not on
// the server. When the phone regains network it uploads any files first
// (through the existing /uploads route), then posts the captured record
// here. This service does the whole job inside that one request: it creates
// the real Application (or Violation) through the same code paths the
// online flows use, and records the outcome in the OfflineSync ledger.
// Nothing is left "pending" for a background processor, and no cron job is
// involved. The client generated clientRecordId is the idempotency key: a
// record sent twice returns the first result instead of duplicating it.
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/prisma";
import * as ApplicationService from "../application/application.service";
import type {
  SyncOfflineRecordInput,
  OfflineFileInput,
} from "./offline.validation";

export class SyncError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

type Officer = { id: string; email: string; role: string };

// ---------------------------------------------------------------------------
// Citizen resolution
// ---------------------------------------------------------------------------
// Same rules the field officer assisted application flow uses today
// (field.controller.createStaticAccountApplication): reuse the citizen when
// they already exist, otherwise register them with a generated password and
// a forced password reset. Kept here as one function so the offline path
// and the online assisted path cannot drift apart in behaviour.
export async function resolveCitizenForFieldOfficer(
  applicant: SyncOfflineRecordInput["applicant"],
): Promise<{ citizenId: string; newCitizenCreated: boolean }> {
  if (!applicant) {
    throw new SyncError(
      "Applicant details are required to sync an application",
      "VALIDATION_ERROR",
      400,
    );
  }

  if (applicant.applicantId) {
    const citizen = await prisma.user.findUnique({
      where: { id: applicant.applicantId },
      select: { id: true },
    });
    if (!citizen) {
      throw new SyncError("Applicant not found", "NOT_FOUND", 404);
    }
    return { citizenId: citizen.id, newCitizenCreated: false };
  }

  const { firstName, lastName, email, phone } = applicant;
  if (!firstName || !lastName || !email) {
    throw new SyncError(
      "firstName, lastName and email are required to register a new citizen",
      "VALIDATION_ERROR",
      400,
    );
  }

  const normalizedEmail = email.toLowerCase().trim();
  const byEmail = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (byEmail) return { citizenId: byEmail.id, newCitizenCreated: false };

  if (phone) {
    const byPhone = await prisma.user.findUnique({
      where: { phone: phone.trim() },
      select: { id: true },
    });
    if (byPhone) return { citizenId: byPhone.id, newCitizenCreated: false };
  }

  const generatedPassword = crypto.randomBytes(6).toString("base64url");
  const hashedPassword = await bcrypt.hash(generatedPassword, 10);

  const citizen = await prisma.user.create({
    data: {
      email: normalizedEmail,
      phone: phone ? phone.trim() : undefined,
      firstName,
      lastName,
      password: hashedPassword,
      role: "citizen",
      passwordResetRequired: true,
      isActive: true,
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });

  return { citizenId: citizen.id, newCitizenCreated: true };
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------
async function syncApplication(officer: Officer, input: SyncOfflineRecordInput) {
  const serviceRef = input.serviceId || input.serviceCode;
  if (!serviceRef) {
    throw new SyncError(
      "serviceId or serviceCode is required for an application sync",
      "VALIDATION_ERROR",
      400,
    );
  }

  const service = await prisma.service.findFirst({
    where: { OR: [{ id: serviceRef }, { code: serviceRef }] },
    select: { id: true, code: true, isActive: true },
  });
  if (!service) {
    throw new SyncError("Service not found", "NOT_FOUND", 404);
  }
  if (!service.isActive) {
    throw new SyncError("Service is not active", "SERVICE_INACTIVE", 400);
  }

  const { citizenId, newCitizenCreated } =
    await resolveCitizenForFieldOfficer(input.applicant);

  // The device uploads files through /uploads before syncing and sends the
  // resulting manifest. Map it onto the file shape the application service
  // already persists as application documents.
  const files = (input.files ?? []).map((file: OfflineFileInput) => ({
    originalName: file.originalName,
    fileName: file.fileName,
    relativePath: file.url,
    url: file.url,
    documentType: file.documentType ?? "supporting_document",
  }));

  const { application, invoice } =
    await ApplicationService.createOrUpdateApplication({
      mode: "create",
      applicantId: citizenId,
      createdById: officer.id,
      serviceId: service.id,
      formData: input.formData as Prisma.InputJsonValue,
      files,
      // The invoice is created so the citizen can pay afterwards through
      // the normal online channels. No payment is taken or recorded in the
      // offline flow, ever.
      createInvoice: true,
    });

  return {
    serviceCode: service.code,
    resultId: application.id,
    result: {
      application: {
        id: application.id,
        applicationNumber: application.applicationNumber,
        status: application.status,
      },
      invoice: invoice
        ? { id: invoice.id, invoiceNumber: invoice.invoiceNumber }
        : null,
      newCitizenCreated,
    },
  };
}

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------
const SEVERITY_MAP: Record<string, "minor" | "moderate" | "critical"> = {
  minor: "minor",
  moderate: "moderate",
  major: "moderate", // the frontend form has long sent "major"; the schema enum is "moderate"
  critical: "critical",
};

async function syncViolation(officer: Officer, input: SyncOfflineRecordInput) {
  const data = input.formData as Record<string, unknown>;
  const description = String(data.description ?? "").trim();
  const wardId = String(data.wardId ?? "");
  const businessId = data.businessId ? String(data.businessId) : undefined;
  const businessName = data.businessName ? String(data.businessName) : undefined;
  const address = data.address ? String(data.address) : undefined;
  const severity = SEVERITY_MAP[String(data.severity ?? "minor")] ?? "minor";

  if (!description) {
    throw new SyncError("Description is required", "VALIDATION_ERROR", 400);
  }
  if (!businessId && !businessName) {
    throw new SyncError(
      "Either businessId or businessName is required",
      "VALIDATION_ERROR",
      400,
    );
  }

  const ward = await prisma.ward.findUnique({ where: { id: wardId } });
  if (!ward) {
    throw new SyncError("Ward not found", "NOT_FOUND", 404);
  }

  const violation = await prisma.violation.create({
    data: {
      businessId: businessId ?? null,
      businessName: businessId ? null : businessName,
      address: businessId ? null : address,
      wardId,
      description,
      severity,
      status: "open",
      loggedById: officer.id,
    },
  });

  return {
    serviceCode: "violation",
    resultId: violation.id,
    result: { violation: { id: violation.id, status: violation.status } },
  };
}

// ---------------------------------------------------------------------------
// The sync entry point
// ---------------------------------------------------------------------------
export async function syncOfflineRecord(
  officer: Officer,
  input: SyncOfflineRecordInput,
) {
  const capturedAt = new Date(input.capturedAt);
  if (Number.isNaN(capturedAt.getTime())) {
    throw new SyncError(
      "capturedAt must be a valid date",
      "VALIDATION_ERROR",
      400,
    );
  }

  // Idempotency: claim the ledger row first. The unique clientRecordId is
  // what makes a retried sync safe.
  let ledger = await prisma.offlineSync.findUnique({
    where: { clientRecordId: input.clientRecordId },
  });

  if (ledger && ledger.officerId !== officer.id) {
    throw new SyncError(
      "This record belongs to a different field officer",
      "FORBIDDEN",
      403,
    );
  }

  if (ledger?.status === "synced") {
    // Already done. Return the first outcome, create nothing.
    return {
      ledger,
      result: {
        applicationId: ledger.applicationId,
        violationId: ledger.violationId,
        duplicate: true,
      },
    };
  }

  if (ledger?.status === "processing") {
    throw new SyncError(
      "This record is already syncing. Wait for it to finish before retrying.",
      "SYNC_IN_PROGRESS",
      409,
    );
  }

  const ledgerData = {
    recordType: input.recordType,
    officerId: officer.id,
    formType:
      input.recordType === "violation"
        ? "violation"
        : input.serviceCode || input.serviceId || "application",
    formData: input.formData as Prisma.InputJsonValue,
    applicantData:
      (input.applicant as Prisma.InputJsonValue | undefined) ?? undefined,
    files: (input.files ?? []) as unknown as Prisma.InputJsonValue,
    editHistory: (input.editHistory ?? []) as unknown as Prisma.InputJsonValue,
    source: input.source,
    capturedAt,
    status: "processing",
    failureReason: null,
  };

  ledger = ledger
    ? await prisma.offlineSync.update({
        where: { id: ledger.id },
        data: ledgerData,
      })
    : await prisma.offlineSync.create({
        data: { clientRecordId: input.clientRecordId, ...ledgerData },
      });

  try {
    const outcome =
      input.recordType === "violation"
        ? await syncViolation(officer, input)
        : await syncApplication(officer, input);

    const updated = await prisma.offlineSync.update({
      where: { id: ledger.id },
      data: {
        status: "synced",
        formType: outcome.serviceCode,
        applicationId:
          input.recordType === "application" ? outcome.resultId : null,
        violationId: input.recordType === "violation" ? outcome.resultId : null,
        syncedAt: new Date(),
        failureReason: null,
      },
    });

    // The permanent trail: who captured this, when it was captured on the
    // device, and every edit the officer made to it before sync.
    await prisma.auditLog.create({
      data: {
        action:
          input.recordType === "violation"
            ? "complaint_logged"
            : "application_created",
        entity: input.recordType === "violation" ? "Violation" : "Application",
        entityId: outcome.resultId,
        userId: officer.id,
        details: {
          offline: true,
          clientRecordId: input.clientRecordId,
          capturedAt: capturedAt.toISOString(),
          editHistory: input.editHistory ?? [],
        } as Prisma.InputJsonValue,
      },
    });

    return { ledger: updated, result: outcome.result };
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "Sync failed for an unknown reason";
    await prisma.offlineSync.update({
      where: { id: ledger.id },
      data: { status: "failed", failureReason: reason },
    });

    if (err instanceof SyncError) throw err;
    const anyErr = err as { statusCode?: number; code?: string };
    throw new SyncError(
      reason,
      anyErr.code ?? "SYNC_FAILED",
      anyErr.statusCode ?? 400,
    );
  }
}

export async function getSyncStatus(officer: Officer, id: string) {
  const ledger = await prisma.offlineSync.findFirst({
    where: {
      officerId: officer.id,
      OR: [{ id }, { clientRecordId: id }],
    },
    include: { application: true, violation: true },
  });
  if (!ledger) {
    throw new SyncError("Offline sync record not found", "NOT_FOUND", 404);
  }
  return ledger;
}

export async function listMySyncRecords(officer: Officer, limit = 100) {
  return prisma.offlineSync.findMany({
    where: { officerId: officer.id },
    orderBy: { capturedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    select: {
      id: true,
      clientRecordId: true,
      recordType: true,
      formType: true,
      status: true,
      failureReason: true,
      applicationId: true,
      violationId: true,
      capturedAt: true,
      submittedAt: true,
      syncedAt: true,
    },
  });
}

export async function markForRetry(officer: Officer, id: string) {
  const ledger = await getSyncStatus(officer, id);
  if (ledger.status === "synced") {
    throw new SyncError(
      "This record has already synced. It cannot be retried.",
      "ALREADY_SYNCED",
      400,
    );
  }
  // Retry is an instruction to the device, not server side processing: the
  // phone resends the record to POST /offline/sync with the same
  // clientRecordId, and the idempotency check above protects the resend.
  return prisma.offlineSync.update({
    where: { id: ledger.id },
    data: { status: "pending", failureReason: null, syncedAt: null },
  });
}
