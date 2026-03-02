/*
  Warnings:

  - You are about to drop the column `cancellationPolicyHours` on the `Restaurant` table. All the data in the column will be lost.
  - You are about to drop the column `cancellationPolicyText` on the `Restaurant` table. All the data in the column will be lost.
  - You are about to drop the `WaitlistEntry` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "WaitlistEntry" DROP CONSTRAINT "WaitlistEntry_restaurantId_fkey";

-- AlterTable
ALTER TABLE "Restaurant" DROP COLUMN "cancellationPolicyHours",
DROP COLUMN "cancellationPolicyText";

-- DropTable
DROP TABLE "WaitlistEntry";
