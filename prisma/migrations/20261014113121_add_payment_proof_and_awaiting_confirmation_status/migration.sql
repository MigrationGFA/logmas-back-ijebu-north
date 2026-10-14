-- AlterEnum
ALTER TYPE "ApplicationStatus" ADD VALUE 'awaiting_payment_confirmation';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "proofUploadedAt" TIMESTAMP(3),
ADD COLUMN     "proofUploadedById" TEXT,
ADD COLUMN     "proofUrl" TEXT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_proofUploadedById_fkey" FOREIGN KEY ("proofUploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
