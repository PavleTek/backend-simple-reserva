-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referrerOrganizationId" TEXT NOT NULL,
    "refereeOrganizationId" TEXT NOT NULL,
    "refereeEmail" TEXT,
    "refereePhone" TEXT,
    "attributionSource" TEXT NOT NULL DEFAULT 'url',
    "status" TEXT NOT NULL DEFAULT 'registered',
    "signupIp" TEXT,
    "signupUserAgent" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstPaymentAt" TIMESTAMP(3),
    "qualifyingPaymentAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rewardAppliedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "rejectionReason" TEXT,
    "internalNotes" TEXT,
    "isFraud" BOOLEAN NOT NULL DEFAULT false,
    "fraudNote" TEXT,
    "rewardCreditId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCredit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'referral',
    "sourceReferralId" TEXT,
    "amountDays" INTEGER NOT NULL DEFAULT 30,
    "status" TEXT NOT NULL DEFAULT 'available',
    "appliedAt" TIMESTAMP(3),
    "appliedToSubscriptionId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralCredit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Referral_refereeOrganizationId_key" ON "Referral"("refereeOrganizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_rewardCreditId_key" ON "Referral"("rewardCreditId");

-- CreateIndex
CREATE INDEX "Referral_referrerOrganizationId_idx" ON "Referral"("referrerOrganizationId");

-- CreateIndex
CREATE INDEX "Referral_status_idx" ON "Referral"("status");

-- CreateIndex
CREATE INDEX "Referral_firstPaymentAt_idx" ON "Referral"("firstPaymentAt");

-- CreateIndex
CREATE INDEX "Referral_createdAt_idx" ON "Referral"("createdAt");

-- CreateIndex
CREATE INDEX "ReferralCredit_organizationId_idx" ON "ReferralCredit"("organizationId");

-- CreateIndex
CREATE INDEX "ReferralCredit_status_idx" ON "ReferralCredit"("status");

-- CreateIndex
CREATE INDEX "ReferralCredit_sourceReferralId_idx" ON "ReferralCredit"("sourceReferralId");

-- CreateIndex
CREATE INDEX "ReferralCredit_expiresAt_idx" ON "ReferralCredit"("expiresAt");

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerOrganizationId_fkey" FOREIGN KEY ("referrerOrganizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_refereeOrganizationId_fkey" FOREIGN KEY ("refereeOrganizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_rewardCreditId_fkey" FOREIGN KEY ("rewardCreditId") REFERENCES "ReferralCredit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCredit" ADD CONSTRAINT "ReferralCredit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCredit" ADD CONSTRAINT "ReferralCredit_sourceReferralId_fkey" FOREIGN KEY ("sourceReferralId") REFERENCES "Referral"("id") ON DELETE SET NULL ON UPDATE CASCADE;
