-- AlterTable
ALTER TABLE "Plan" ADD COLUMN "freeTrialLength" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN "freeTrialLengthUnit" TEXT NOT NULL DEFAULT 'months';
ALTER TABLE "Plan" ADD COLUMN "mercadopagoPreapprovalPlanId" TEXT;
ALTER TABLE "Plan" ADD COLUMN "mercadopagoInitPoint" TEXT;
ALTER TABLE "Plan" ADD COLUMN "mercadopagoLastSyncAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_mercadopagoPreapprovalPlanId_key" ON "Plan"("mercadopagoPreapprovalPlanId");
