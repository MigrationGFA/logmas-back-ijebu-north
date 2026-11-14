-- FO-only services (Nov 14, 2026): services a treasurer manages for
-- field-officer collection only. They are never listed publicly, carry no
-- fixed fee (the officer records the amount actually paid), issue no
-- certificate, and can sit in a catch-all OTHERS category. Service CRUD by
-- the treasurer is written to the audit log.
ALTER TYPE "ServiceCategory" ADD VALUE IF NOT EXISTS 'OTHERS';
ALTER TYPE "CertificateType" ADD VALUE IF NOT EXISTS 'NONE';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'service_created';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'service_updated';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'service_deleted';
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "foOnly" BOOLEAN NOT NULL DEFAULT false;
