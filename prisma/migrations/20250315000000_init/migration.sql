-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

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
    "planId" TEXT NOT NULL,
    "trialEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "billingType" TEXT NOT NULL DEFAULT 'boleta',
    "billingTaxId" TEXT,
    "billingBusinessName" TEXT,
    "billingAddress" TEXT,
    "billingEmail" TEXT,

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
    "scheduleMode" TEXT NOT NULL DEFAULT 'continuous',
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
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "breakfastStartTime" TEXT,
    "breakfastEndTime" TEXT,
    "lunchStartTime" TEXT,
    "lunchEndTime" TEXT,
    "dinnerStartTime" TEXT,
    "dinnerEndTime" TEXT,

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
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'trial',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "gracePeriodEndsAt" TIMESTAMP(3),
    "mercadopagoPreapprovalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDomain" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSender" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "domainId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Configuration" (
    "id" TEXT NOT NULL,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "appName" TEXT NOT NULL DEFAULT 'SimpleReserva',
    "recoveryEmailSenderId" TEXT,
    "reservationEmailSenderId" TEXT,
    "dashboardPollingIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Configuration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "productSKU" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'restaurant',
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "maxRestaurants" INTEGER NOT NULL,
    "maxZonesPerRestaurant" INTEGER,
    "maxTables" INTEGER,
    "maxTeamMembers" INTEGER,
    "whatsappFeatures" BOOLEAN NOT NULL DEFAULT true,
    "googleReserveIntegration" BOOLEAN NOT NULL DEFAULT false,
    "multipleMenu" BOOLEAN NOT NULL DEFAULT false,
    "prioritySupport" BOOLEAN NOT NULL DEFAULT false,
    "priceCLP" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "priceUSD" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "priceEUR" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "billingFrequency" INTEGER NOT NULL DEFAULT 1,
    "billingFrequencyType" TEXT NOT NULL DEFAULT 'months',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "ReservationAnalytics" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "restaurantId" TEXT,
    "organizationId" TEXT,
    "reservationCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "planId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "receiptType" TEXT NOT NULL,
    "clientName" TEXT,
    "clientEmail" TEXT,
    "clientTaxId" TEXT,
    "clientBusinessName" TEXT,
    "clientAddress" TEXT,
    "mercadopagoPaymentId" TEXT,
    "mercadopagoStatus" TEXT,
    "legalReceiptSent" BOOLEAN NOT NULL DEFAULT false,
    "legalReceiptSentAt" TIMESTAMP(3),
    "legalReceiptSentBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckoutSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mercadopagoPreapprovalId" TEXT,
    "checkoutUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CheckoutSession_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "EmailDomain_domain_key" ON "EmailDomain"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSender_email_key" ON "EmailSender"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_productSKU_key" ON "Plan"("productSKU");

-- CreateIndex
CREATE INDEX "BookingEvent_restaurantId_eventName_timestamp_idx" ON "BookingEvent"("restaurantId", "eventName", "timestamp");

-- CreateIndex
CREATE INDEX "BookingEvent_sessionId_idx" ON "BookingEvent"("sessionId");

-- CreateIndex
CREATE INDEX "BookingEvent_timestamp_idx" ON "BookingEvent"("timestamp");

-- CreateIndex
CREATE INDEX "ReservationAnalytics_date_idx" ON "ReservationAnalytics"("date");

-- CreateIndex
CREATE INDEX "ReservationAnalytics_restaurantId_date_idx" ON "ReservationAnalytics"("restaurantId", "date");

-- CreateIndex
CREATE INDEX "ReservationAnalytics_organizationId_date_idx" ON "ReservationAnalytics"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReceipt_mercadopagoPaymentId_key" ON "PaymentReceipt"("mercadopagoPaymentId");

-- CreateIndex
CREATE INDEX "PaymentReceipt_organizationId_idx" ON "PaymentReceipt"("organizationId");

-- CreateIndex
CREATE INDEX "PaymentReceipt_legalReceiptSent_idx" ON "PaymentReceipt"("legalReceiptSent");

-- CreateIndex
CREATE INDEX "PaymentReceipt_paymentDate_idx" ON "PaymentReceipt"("paymentDate");

-- CreateIndex
CREATE INDEX "PaymentReceipt_receiptType_idx" ON "PaymentReceipt"("receiptType");

-- CreateIndex
CREATE INDEX "CheckoutSession_organizationId_idx" ON "CheckoutSession"("organizationId");

-- CreateIndex
CREATE INDEX "CheckoutSession_userId_idx" ON "CheckoutSession"("userId");

-- CreateIndex
CREATE INDEX "CheckoutSession_status_idx" ON "CheckoutSession"("status");

-- AddForeignKey
ALTER TABLE "RestaurantOrganization" ADD CONSTRAINT "RestaurantOrganization_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestaurantOrganization" ADD CONSTRAINT "RestaurantOrganization_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSender" ADD CONSTRAINT "EmailSender_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "EmailDomain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationAnalytics" ADD CONSTRAINT "ReservationAnalytics_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationAnalytics" ADD CONSTRAINT "ReservationAnalytics_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
