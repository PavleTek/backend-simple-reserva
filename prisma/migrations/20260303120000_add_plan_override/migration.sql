-- CreateTable
CREATE TABLE "PlanOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "biweeklyPriceCLP" INTEGER,
    "menuPdf" BOOLEAN,
    "advancedBookingSettings" BOOLEAN,
    "brandingRemoval" BOOLEAN,
    "analyticsWeekly" BOOLEAN,
    "analyticsMonthly" BOOLEAN,
    "crossLocationDashboard" BOOLEAN,
    "prioritySupport" BOOLEAN,
    "maxLocations" INTEGER,
    "maxZones" INTEGER,
    "maxTables" INTEGER,
    "maxTeamMembers" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanOverride_userId_key" ON "PlanOverride"("userId");

-- CreateIndex
CREATE INDEX "PlanOverride_expiresAt_idx" ON "PlanOverride"("expiresAt");

-- AddForeignKey
ALTER TABLE "PlanOverride" ADD CONSTRAINT "PlanOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
