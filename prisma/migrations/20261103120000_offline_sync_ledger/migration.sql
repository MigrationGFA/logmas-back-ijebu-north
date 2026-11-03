-- Offline sync ledger.
--
-- The OfflineSync model was added to schema.prisma in Oct 2026 without a
-- migration (and migration_lock.toml was deleted in the same commit), so
-- databases built with `prisma migrate deploy` may not have the table at
-- all, while databases built with `prisma db push` may have the first,
-- smaller shape. This migration therefore creates the final table when it
-- is missing and adds any missing columns when it already exists.

CREATE TABLE IF NOT EXISTS "OfflineSync" (
    "id" TEXT NOT NULL,
    "clientRecordId" TEXT NOT NULL,
    "recordType" TEXT NOT NULL DEFAULT 'application',
    "officerId" TEXT NOT NULL,
    "applicationId" TEXT,
    "violationId" TEXT,
    "formType" TEXT NOT NULL,
    "formData" JSONB NOT NULL,
    "applicantData" JSONB,
    "files" JSONB,
    "editHistory" JSONB,
    "source" TEXT NOT NULL DEFAULT 'field_officer',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failureReason" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfflineSync_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OfflineSync" ADD COLUMN IF NOT EXISTS "clientRecordId" TEXT;
ALTER TABLE "OfflineSync" ADD COLUMN IF NOT EXISTS "recordType" TEXT NOT NULL DEFAULT 'application';
ALTER TABLE "OfflineSync" ADD COLUMN IF NOT EXISTS "officerId" TEXT;
ALTER TABLE "OfflineSync" ADD COLUMN IF NOT EXISTS "violationId" TEXT;
ALTER TABLE "OfflineSync" ADD COLUMN IF NOT EXISTS "applicantData" JSONB;
ALTER TABLE "OfflineSync" ADD COLUMN IF NOT EXISTS "files" JSONB;
ALTER TABLE "OfflineSync" ADD COLUMN IF NOT EXISTS "editHistory" JSONB;
ALTER TABLE "OfflineSync" ADD COLUMN IF NOT EXISTS "failureReason" TEXT;
ALTER TABLE "OfflineSync" ADD COLUMN IF NOT EXISTS "capturedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "OfflineSync_clientRecordId_key" ON "OfflineSync"("clientRecordId");
CREATE INDEX IF NOT EXISTS "OfflineSync_officerId_idx" ON "OfflineSync"("officerId");
CREATE INDEX IF NOT EXISTS "OfflineSync_status_idx" ON "OfflineSync"("status");

-- Foreign keys, added only when the constraint is not already present.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OfflineSync_officerId_fkey') THEN
        ALTER TABLE "OfflineSync" ADD CONSTRAINT "OfflineSync_officerId_fkey"
            FOREIGN KEY ("officerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OfflineSync_applicationId_fkey') THEN
        ALTER TABLE "OfflineSync" ADD CONSTRAINT "OfflineSync_applicationId_fkey"
            FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OfflineSync_violationId_fkey') THEN
        ALTER TABLE "OfflineSync" ADD CONSTRAINT "OfflineSync_violationId_fkey"
            FOREIGN KEY ("violationId") REFERENCES "violations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
