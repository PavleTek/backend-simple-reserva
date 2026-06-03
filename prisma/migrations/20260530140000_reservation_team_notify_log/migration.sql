-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "teamNotifySent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "teamNotifySentAt" TIMESTAMP(3),
ADD COLUMN     "teamNotifyRecipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "teamNotifySkipReason" TEXT;
