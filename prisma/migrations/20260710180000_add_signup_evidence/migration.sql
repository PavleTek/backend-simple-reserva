-- AlterTable
ALTER TABLE "RestaurantOrganization" ADD COLUMN "signupRegisteredByUserId" TEXT,
ADD COLUMN "signupTermsAcceptedAt" TIMESTAMP(3),
ADD COLUMN "signupTermsVersion" TEXT,
ADD COLUMN "signupIp" TEXT,
ADD COLUMN "signupUserAgent" TEXT;

-- CreateTable
CREATE TABLE "OrganizationSignupEmailLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "subject" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "resendId" TEXT,
    "sentAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'live',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationSignupEmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RestaurantOrganization_signupRegisteredByUserId_idx" ON "RestaurantOrganization"("signupRegisteredByUserId");

-- CreateIndex
CREATE INDEX "OrganizationSignupEmailLog_organizationId_idx" ON "OrganizationSignupEmailLog"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationSignupEmailLog_recipientEmail_idx" ON "OrganizationSignupEmailLog"("recipientEmail");

-- CreateIndex
CREATE INDEX "OrganizationSignupEmailLog_sentAt_idx" ON "OrganizationSignupEmailLog"("sentAt");

-- CreateIndex
CREATE INDEX "OrganizationSignupEmailLog_kind_idx" ON "OrganizationSignupEmailLog"("kind");

-- AddForeignKey
ALTER TABLE "RestaurantOrganization" ADD CONSTRAINT "RestaurantOrganization_signupRegisteredByUserId_fkey" FOREIGN KEY ("signupRegisteredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationSignupEmailLog" ADD CONSTRAINT "OrganizationSignupEmailLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
