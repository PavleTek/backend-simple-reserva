-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "emailSent" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "customerPhone" DROP NOT NULL;
