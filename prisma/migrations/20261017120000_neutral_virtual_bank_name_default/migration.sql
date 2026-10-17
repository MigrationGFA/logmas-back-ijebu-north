-- Neutralize the LGA-specific default on Invoice.virtualBankName so that
-- cloned LGA deployments don't inherit another LGA's branding. Runtime code
-- sets the real bank name from the payment gateway once a virtual account is
-- assigned; the neutral default only applies to rows created before that.
ALTER TABLE "invoices" ALTER COLUMN "virtualBankName" SET DEFAULT 'Local Government Treasury';
