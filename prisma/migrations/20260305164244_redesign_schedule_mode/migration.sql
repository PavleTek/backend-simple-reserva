/*
  Warnings:

  - You are about to drop the column `breakEndTime` on the `Schedule` table. All the data in the column will be lost.
  - You are about to drop the column `breakStartTime` on the `Schedule` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "scheduleMode" TEXT NOT NULL DEFAULT 'continuous';

-- AlterTable
ALTER TABLE "Schedule" DROP COLUMN "breakEndTime",
DROP COLUMN "breakStartTime",
ADD COLUMN     "breakfastEndTime" TEXT,
ADD COLUMN     "breakfastStartTime" TEXT,
ADD COLUMN     "dinnerEndTime" TEXT,
ADD COLUMN     "dinnerStartTime" TEXT,
ADD COLUMN     "lunchEndTime" TEXT,
ADD COLUMN     "lunchStartTime" TEXT;
