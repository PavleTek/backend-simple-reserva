-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "requireEmail" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "requirePhoneNumber" BOOLEAN NOT NULL DEFAULT false;
