-- CreateTable
CREATE TABLE "CustomPlanOffer" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "offeredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomPlanOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomPlanOffer_organizationId_idx" ON "CustomPlanOffer"("organizationId");

-- CreateIndex
CREATE INDEX "CustomPlanOffer_planId_idx" ON "CustomPlanOffer"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomPlanOffer_planId_organizationId_key" ON "CustomPlanOffer"("planId", "organizationId");

-- AddForeignKey
ALTER TABLE "CustomPlanOffer" ADD CONSTRAINT "CustomPlanOffer_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomPlanOffer" ADD CONSTRAINT "CustomPlanOffer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomPlanOffer" ADD CONSTRAINT "CustomPlanOffer_offeredById_fkey" FOREIGN KEY ("offeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
