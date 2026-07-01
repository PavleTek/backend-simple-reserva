-- CreateEnum
CREATE TYPE "OwnershipTransferStatus" AS ENUM ('pending', 'accepted', 'declined', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "OutgoingOwnerDisposition" AS ENUM ('manager', 'leave');

-- CreateTable
CREATE TABLE "OwnershipTransfer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "initiatedByUserId" TEXT,
    "fromOwnerId" TEXT,
    "targetEmail" TEXT NOT NULL,
    "targetUserId" TEXT,
    "outgoingOwnerDisposition" "OutgoingOwnerDisposition" NOT NULL DEFAULT 'manager',
    "status" "OwnershipTransferStatus" NOT NULL DEFAULT 'pending',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnershipTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnershipTransfer_tokenHash_key" ON "OwnershipTransfer"("tokenHash");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_organizationId_status_idx" ON "OwnershipTransfer"("organizationId", "status");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_targetUserId_idx" ON "OwnershipTransfer"("targetUserId");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_targetEmail_idx" ON "OwnershipTransfer"("targetEmail");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_status_idx" ON "OwnershipTransfer"("status");

-- CreateIndex
CREATE INDEX "OwnershipTransfer_createdAt_idx" ON "OwnershipTransfer"("createdAt");

-- Partial unique: one pending transfer per organization
CREATE UNIQUE INDEX "OwnershipTransfer_one_pending_per_org" ON "OwnershipTransfer"("organizationId") WHERE ("status" = 'pending');

-- AddForeignKey
ALTER TABLE "OwnershipTransfer" ADD CONSTRAINT "OwnershipTransfer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipTransfer" ADD CONSTRAINT "OwnershipTransfer_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipTransfer" ADD CONSTRAINT "OwnershipTransfer_fromOwnerId_fkey" FOREIGN KEY ("fromOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipTransfer" ADD CONSTRAINT "OwnershipTransfer_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
