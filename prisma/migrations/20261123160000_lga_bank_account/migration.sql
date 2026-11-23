-- LGA collection bank account for FO-only services (Nov 23, 2026).
-- One row by design: the account every FO collection is paid into,
-- managed from dashboard Settings by treasurer / admin roles only.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'bank_account_updated';

CREATE TABLE IF NOT EXISTS "lga_bank_accounts" (
    "id" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lga_bank_accounts_pkey" PRIMARY KEY ("id")
);
