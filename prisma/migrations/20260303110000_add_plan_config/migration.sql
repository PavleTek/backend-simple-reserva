-- CreateTable
CREATE TABLE "PlanConfig" (
    "id" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "smsConfirmations" BOOLEAN NOT NULL DEFAULT true,
    "smsReminders" BOOLEAN NOT NULL DEFAULT true,
    "whatsappConfirmations" BOOLEAN NOT NULL DEFAULT true,
    "whatsappReminders" BOOLEAN NOT NULL DEFAULT true,
    "whatsappModificationAlerts" BOOLEAN NOT NULL DEFAULT true,
    "menuPdf" BOOLEAN NOT NULL DEFAULT false,
    "advancedBookingSettings" BOOLEAN NOT NULL DEFAULT false,
    "brandingRemoval" BOOLEAN NOT NULL DEFAULT false,
    "analyticsWeekly" BOOLEAN NOT NULL DEFAULT false,
    "analyticsMonthly" BOOLEAN NOT NULL DEFAULT false,
    "crossLocationDashboard" BOOLEAN NOT NULL DEFAULT false,
    "prioritySupport" BOOLEAN NOT NULL DEFAULT false,
    "maxLocations" INTEGER NOT NULL,
    "maxZones" INTEGER,
    "maxTables" INTEGER,
    "maxTeamMembers" INTEGER,
    "biweeklyPriceCLP" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CLP',
    "billingFrequencyDays" INTEGER NOT NULL DEFAULT 15,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanConfig_plan_key" ON "PlanConfig"("plan");
