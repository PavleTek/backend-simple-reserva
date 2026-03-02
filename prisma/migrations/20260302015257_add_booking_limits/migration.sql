-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "advanceBookingLimitDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "minimumNoticeMinutes" INTEGER NOT NULL DEFAULT 60;
