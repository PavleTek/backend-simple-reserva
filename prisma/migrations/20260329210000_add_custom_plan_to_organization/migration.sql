-- Plan personalizado por organización: permite asignar tarifas o condiciones especiales a un cliente específico.
-- customPlanId es nullable: la mayoría de orgs usan los planes públicos (isDefault=true).
-- Cuando está seteado, el plan se muestra en BillingPage además de los planes públicos.

-- AlterTable
ALTER TABLE "RestaurantOrganization" ADD COLUMN "customPlanId" TEXT;

-- CreateIndex
CREATE INDEX "RestaurantOrganization_customPlanId_idx" ON "RestaurantOrganization"("customPlanId");

-- AddForeignKey
ALTER TABLE "RestaurantOrganization" ADD CONSTRAINT "RestaurantOrganization_customPlanId_fkey" FOREIGN KEY ("customPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
