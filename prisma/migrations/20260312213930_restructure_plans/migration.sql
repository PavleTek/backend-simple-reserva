/*
  Warnings:

  - You are about to drop the column `planConfigId` on the `RestaurantOrganization` table. All the data in the column will be lost.
  - You are about to drop the column `plan` on the `Subscription` table. All the data in the column will be lost.
  - You are about to drop the `PlanConfig` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PlanOverride` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `planId` to the `RestaurantOrganization` table without a default value. This is not possible if the table is not empty.
  - Added the required column `planId` to the `Subscription` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "PlanOverride" DROP CONSTRAINT "PlanOverride_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "RestaurantOrganization" DROP CONSTRAINT "RestaurantOrganization_planConfigId_fkey";

-- AlterTable
ALTER TABLE "RestaurantOrganization" DROP COLUMN "planConfigId",
ADD COLUMN     "planId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Subscription" DROP COLUMN "plan",
ADD COLUMN     "planId" TEXT NOT NULL;

-- DropTable
DROP TABLE "PlanConfig";

-- DropTable
DROP TABLE "PlanOverride";

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "productSKU" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'restaurant',
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "maxRestaurants" INTEGER NOT NULL,
    "maxZonesPerRestaurant" INTEGER,
    "maxTables" INTEGER,
    "maxTeamMembers" INTEGER,
    "whatsappFeatures" BOOLEAN NOT NULL DEFAULT true,
    "googleReserveIntegration" BOOLEAN NOT NULL DEFAULT false,
    "multipleMenu" BOOLEAN NOT NULL DEFAULT false,
    "prioritySupport" BOOLEAN NOT NULL DEFAULT false,
    "priceCLP" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "priceUSD" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "priceEUR" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "billingFrequency" INTEGER NOT NULL DEFAULT 1,
    "billingFrequencyType" TEXT NOT NULL DEFAULT 'months',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_productSKU_key" ON "Plan"("productSKU");

-- AddForeignKey
ALTER TABLE "RestaurantOrganization" ADD CONSTRAINT "RestaurantOrganization_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
