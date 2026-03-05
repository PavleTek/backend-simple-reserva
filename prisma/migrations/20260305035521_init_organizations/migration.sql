-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "lastName" TEXT,
    "hashedPassword" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'CL',
    "lastLogin" TIMESTAMP(3),
    "twoFactorSecret" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "userEnabledTwoFactor" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorRecoveryCode" TEXT,
    "twoFactorRecoveryCodeExpires" TIMESTAMP(3),
    "passwordResetCode" TEXT,
    "passwordResetCodeExpires" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantOrganization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "planConfigId" TEXT NOT NULL,
    "trialEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantOrganization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationManager" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationManager_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagerRestaurantAssignment" (
    "id" TEXT NOT NULL,
    "organizationManagerId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagerRestaurantAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Restaurant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "logoUrl" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "defaultSlotDurationMinutes" INTEGER NOT NULL DEFAULT 60,
    "bufferMinutesBetweenReservations" INTEGER NOT NULL DEFAULT 0,
    "advanceBookingLimitDays" INTEGER NOT NULL DEFAULT 30,
    "minimumNoticeMinutes" INTEGER NOT NULL DEFAULT 60,
    "noShowGracePeriodMinutes" INTEGER NOT NULL DEFAULT 15,
    "menuPdfUrl" TEXT,
    "timezone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "dataVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Restaurant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantMenu" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "menuType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "r2Key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestaurantMenu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DurationRule" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "minPartySize" INTEGER NOT NULL,
    "maxPartySize" INTEGER NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DurationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantTable" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "minCapacity" INTEGER NOT NULL DEFAULT 1,
    "maxCapacity" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestaurantTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "openTime" TEXT NOT NULL,
    "closeTime" TEXT NOT NULL,
    "breakStartTime" TEXT,
    "breakEndTime" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockedSlot" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "startDatetime" TIMESTAMP(3) NOT NULL,
    "endDatetime" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,

    CONSTRAINT "BlockedSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "tableId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "customerEmail" TEXT,
    "partySize" INTEGER NOT NULL,
    "dateTime" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "source" TEXT NOT NULL DEFAULT 'web',
    "notes" TEXT,
    "secureToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'profesional',
    "status" TEXT NOT NULL DEFAULT 'trial',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "gracePeriodEndsAt" TIMESTAMP(3),
    "mercadopagoPreapprovalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSender" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Configuration" (
    "id" TEXT NOT NULL,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "appName" TEXT NOT NULL DEFAULT 'SimpleReserva',
    "recoveryEmailSenderId" TEXT,
    "dashboardPollingIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Configuration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanConfig" (
    "id" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "isDefaultPlan" BOOLEAN NOT NULL DEFAULT true,
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
    "displayName" TEXT NOT NULL DEFAULT '',
    "description" TEXT,
    "priceCLP" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CLP',
    "billingFrequency" INTEGER NOT NULL DEFAULT 1,
    "billingFrequencyType" TEXT NOT NULL DEFAULT 'months',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "stepName" TEXT,
    "properties" JSONB,
    "deviceType" TEXT,
    "userAgent" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanOverride" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "priceCLP" INTEGER,
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
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantOrganization_ownerId_key" ON "RestaurantOrganization"("ownerId");

-- CreateIndex
CREATE INDEX "RestaurantOrganization_ownerId_idx" ON "RestaurantOrganization"("ownerId");

-- CreateIndex
CREATE INDEX "OrganizationManager_organizationId_idx" ON "OrganizationManager"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationManager_userId_idx" ON "OrganizationManager"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationManager_organizationId_userId_key" ON "OrganizationManager"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "ManagerRestaurantAssignment_organizationManagerId_idx" ON "ManagerRestaurantAssignment"("organizationManagerId");

-- CreateIndex
CREATE INDEX "ManagerRestaurantAssignment_restaurantId_idx" ON "ManagerRestaurantAssignment"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagerRestaurantAssignment_organizationManagerId_restauran_key" ON "ManagerRestaurantAssignment"("organizationManagerId", "restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "Restaurant_slug_key" ON "Restaurant"("slug");

-- CreateIndex
CREATE INDEX "Restaurant_organizationId_idx" ON "Restaurant"("organizationId");

-- CreateIndex
CREATE INDEX "Restaurant_isActive_idx" ON "Restaurant"("isActive");

-- CreateIndex
CREATE INDEX "RestaurantMenu_restaurantId_idx" ON "RestaurantMenu"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantMenu_restaurantId_menuType_key" ON "RestaurantMenu"("restaurantId", "menuType");

-- CreateIndex
CREATE INDEX "DurationRule_restaurantId_idx" ON "DurationRule"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "DurationRule_restaurantId_minPartySize_key" ON "DurationRule"("restaurantId", "minPartySize");

-- CreateIndex
CREATE INDEX "Zone_restaurantId_idx" ON "Zone"("restaurantId");

-- CreateIndex
CREATE INDEX "RestaurantTable_zoneId_idx" ON "RestaurantTable"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_restaurantId_dayOfWeek_key" ON "Schedule"("restaurantId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "BlockedSlot_restaurantId_startDatetime_endDatetime_idx" ON "BlockedSlot"("restaurantId", "startDatetime", "endDatetime");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_secureToken_key" ON "Reservation"("secureToken");

-- CreateIndex
CREATE INDEX "Reservation_restaurantId_dateTime_status_idx" ON "Reservation"("restaurantId", "dateTime", "status");

-- CreateIndex
CREATE INDEX "Reservation_secureToken_idx" ON "Reservation"("secureToken");

-- CreateIndex
CREATE INDEX "Subscription_organizationId_idx" ON "Subscription"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSender_email_key" ON "EmailSender"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PlanConfig_plan_key" ON "PlanConfig"("plan");

-- CreateIndex
CREATE INDEX "BookingEvent_restaurantId_eventName_timestamp_idx" ON "BookingEvent"("restaurantId", "eventName", "timestamp");

-- CreateIndex
CREATE INDEX "BookingEvent_sessionId_idx" ON "BookingEvent"("sessionId");

-- CreateIndex
CREATE INDEX "BookingEvent_timestamp_idx" ON "BookingEvent"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "PlanOverride_organizationId_key" ON "PlanOverride"("organizationId");

-- CreateIndex
CREATE INDEX "PlanOverride_organizationId_idx" ON "PlanOverride"("organizationId");

-- CreateIndex
CREATE INDEX "PlanOverride_expiresAt_idx" ON "PlanOverride"("expiresAt");

-- AddForeignKey
ALTER TABLE "RestaurantOrganization" ADD CONSTRAINT "RestaurantOrganization_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantOrganization" ADD CONSTRAINT "RestaurantOrganization_planConfigId_fkey" FOREIGN KEY ("planConfigId") REFERENCES "PlanConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationManager" ADD CONSTRAINT "OrganizationManager_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationManager" ADD CONSTRAINT "OrganizationManager_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerRestaurantAssignment" ADD CONSTRAINT "ManagerRestaurantAssignment_organizationManagerId_fkey" FOREIGN KEY ("organizationManagerId") REFERENCES "OrganizationManager"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerRestaurantAssignment" ADD CONSTRAINT "ManagerRestaurantAssignment_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Restaurant" ADD CONSTRAINT "Restaurant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantMenu" ADD CONSTRAINT "RestaurantMenu_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DurationRule" ADD CONSTRAINT "DurationRule_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantTable" ADD CONSTRAINT "RestaurantTable_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedSlot" ADD CONSTRAINT "BlockedSlot_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "RestaurantTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanOverride" ADD CONSTRAINT "PlanOverride_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
