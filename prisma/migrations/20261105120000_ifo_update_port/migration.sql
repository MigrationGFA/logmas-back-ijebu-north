-- Ifo update port (Nov 5, 2026): sub-admin reviewer role, correction flow,
-- and service fee pricing tiers (layer depth, billing unit, validity, tiers).
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'sub_admin';
ALTER TYPE "ApplicationStatus" ADD VALUE IF NOT EXISTS 'correction_requested';
ALTER TABLE "ServiceFeeConfig" ADD COLUMN IF NOT EXISTS "layerDepth" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ServiceFeeConfig" ADD COLUMN IF NOT EXISTS "billingUnit" TEXT;
ALTER TABLE "ServiceFeeConfig" ADD COLUMN IF NOT EXISTS "effectiveDate" TIMESTAMP(3);
ALTER TABLE "ServiceFeeConfig" ADD COLUMN IF NOT EXISTS "expiryDate" TIMESTAMP(3);
ALTER TABLE "ServiceFeeConfig" ADD COLUMN IF NOT EXISTS "pricingTiers" JSONB;
