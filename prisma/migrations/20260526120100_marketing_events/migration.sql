-- CreateTable
CREATE TABLE "MarketingEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "pagePath" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "ctaId" TEXT,
    "properties" JSONB,
    "deviceType" TEXT,
    "userAgent" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketingEvent_pagePath_eventName_timestamp_idx" ON "MarketingEvent"("pagePath", "eventName", "timestamp");

-- CreateIndex
CREATE INDEX "MarketingEvent_sessionId_idx" ON "MarketingEvent"("sessionId");

-- CreateIndex
CREATE INDEX "MarketingEvent_ctaId_timestamp_idx" ON "MarketingEvent"("ctaId", "timestamp");

-- CreateIndex
CREATE INDEX "MarketingEvent_timestamp_idx" ON "MarketingEvent"("timestamp");
