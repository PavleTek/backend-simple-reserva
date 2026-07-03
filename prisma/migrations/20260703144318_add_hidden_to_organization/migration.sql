-- AlterTable
ALTER TABLE "RestaurantOrganization" ADD COLUMN     "hidden" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "RestaurantOrganization_hidden_idx" ON "RestaurantOrganization"("hidden");
