-- CreateTable
CREATE TABLE "FeedbackSurvey" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "sendDelayMinutes" INTEGER NOT NULL DEFAULT 75,
    "sendWindowMinutes" INTEGER NOT NULL DEFAULT 240,
    "minDaysBetweenFeedbackRequests" INTEGER NOT NULL DEFAULT 14,
    "eligibilityMode" TEXT NOT NULL DEFAULT 'confirmed_past_end',
    "excludeWalkIns" BOOLEAN NOT NULL DEFAULT true,
    "minPartySize" INTEGER,
    "maxPartySize" INTEGER,
    "googleReviewUrl" TEXT,
    "instagramUrl" TEXT,
    "recoveryThreshold" INTEGER NOT NULL DEFAULT 2,
    "notifyOnRecovery" BOOLEAN NOT NULL DEFAULT true,
    "notifyEmail" TEXT,
    "brandingJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedbackSurvey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackRequest" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "customerEmailNormalized" TEXT,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "clickedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedbackRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackResponse" (
    "id" TEXT NOT NULL,
    "feedbackRequestId" TEXT NOT NULL,
    "overallScore" INTEGER NOT NULL,
    "serviceScore" INTEGER,
    "foodScore" INTEGER,
    "atmosphereScore" INTEGER,
    "reservationScore" INTEGER,
    "comment" TEXT,
    "sentiment" TEXT,
    "recoveryTriggered" BOOLEAN NOT NULL DEFAULT false,
    "recoveryContactRequested" BOOLEAN NOT NULL DEFAULT false,
    "recoveryContactEmail" TEXT,
    "recoveryContactPhone" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "partySize" INTEGER,
    "dateTime" TIMESTAMP(3),
    "dayOfWeek" INTEGER,
    "hourBucket" INTEGER,
    "tableId" TEXT,
    "zoneId" TEXT,
    "organizationId" TEXT,
    "cityKey" TEXT,
    "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackAlert" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "feedbackResponseId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'recovery',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "severitySource" TEXT,
    "matchedKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedbackAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerFeedbackPreference" (
    "id" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "restaurantId" TEXT,
    "optedOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerFeedbackPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackSurvey_restaurantId_key" ON "FeedbackSurvey"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackRequest_reservationId_key" ON "FeedbackRequest"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackRequest_token_key" ON "FeedbackRequest"("token");

-- CreateIndex
CREATE INDEX "FeedbackRequest_status_scheduledFor_idx" ON "FeedbackRequest"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "FeedbackRequest_restaurantId_customerEmailNormalized_sentAt_idx" ON "FeedbackRequest"("restaurantId", "customerEmailNormalized", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackResponse_feedbackRequestId_key" ON "FeedbackResponse"("feedbackRequestId");

-- CreateIndex
CREATE INDEX "FeedbackAlert_restaurantId_status_idx" ON "FeedbackAlert"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "CustomerFeedbackPreference_emailHash_idx" ON "CustomerFeedbackPreference"("emailHash");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerFeedbackPreference_emailHash_restaurantId_key" ON "CustomerFeedbackPreference"("emailHash", "restaurantId");

-- AddForeignKey
ALTER TABLE "FeedbackSurvey" ADD CONSTRAINT "FeedbackSurvey_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackRequest" ADD CONSTRAINT "FeedbackRequest_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackRequest" ADD CONSTRAINT "FeedbackRequest_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackResponse" ADD CONSTRAINT "FeedbackResponse_feedbackRequestId_fkey" FOREIGN KEY ("feedbackRequestId") REFERENCES "FeedbackRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackAlert" ADD CONSTRAINT "FeedbackAlert_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackAlert" ADD CONSTRAINT "FeedbackAlert_feedbackResponseId_fkey" FOREIGN KEY ("feedbackResponseId") REFERENCES "FeedbackResponse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
