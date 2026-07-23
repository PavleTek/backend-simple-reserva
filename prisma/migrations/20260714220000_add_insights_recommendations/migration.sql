-- CreateTable
CREATE TABLE "InsightsState" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "lastEvaluatedAt" TIMESTAMP(3),
    "evaluatedDataVersion" INTEGER NOT NULL DEFAULT 0,
    "configFingerprint" TEXT,
    "configStableSince" TIMESTAMP(3),
    "maturityStage" TEXT,
    "weeklySummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsightsState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "periodStart" DATE,
    "periodEnd" DATE,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "actionTakenAt" TIMESTAMP(3),
    "markedUsefulAt" TIMESTAMP(3),
    "firstViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationEvent" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "recommendationId" TEXT,
    "ruleId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InsightsState_restaurantId_key" ON "InsightsState"("restaurantId");

-- CreateIndex
CREATE INDEX "Recommendation_restaurantId_status_idx" ON "Recommendation"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "Recommendation_restaurantId_generatedAt_idx" ON "Recommendation"("restaurantId", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Recommendation_restaurantId_ruleId_dedupeKey_key" ON "Recommendation"("restaurantId", "ruleId", "dedupeKey");

-- CreateIndex
CREATE INDEX "RecommendationEvent_restaurantId_createdAt_idx" ON "RecommendationEvent"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "RecommendationEvent_ruleId_eventType_idx" ON "RecommendationEvent"("ruleId", "eventType");

-- CreateIndex
CREATE INDEX "RecommendationEvent_recommendationId_idx" ON "RecommendationEvent"("recommendationId");

-- AddForeignKey
ALTER TABLE "InsightsState" ADD CONSTRAINT "InsightsState_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationEvent" ADD CONSTRAINT "RecommendationEvent_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationEvent" ADD CONSTRAINT "RecommendationEvent_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
