-- CreateTable
CREATE TABLE "OrganizationHost" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationHost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostRestaurantAssignment" (
    "id" TEXT NOT NULL,
    "organizationHostId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HostRestaurantAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "restaurantId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationHost_organizationId_idx" ON "OrganizationHost"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationHost_userId_idx" ON "OrganizationHost"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationHost_organizationId_userId_key" ON "OrganizationHost"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "HostRestaurantAssignment_organizationHostId_idx" ON "HostRestaurantAssignment"("organizationHostId");

-- CreateIndex
CREATE INDEX "HostRestaurantAssignment_restaurantId_idx" ON "HostRestaurantAssignment"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "HostRestaurantAssignment_organizationHostId_restaurantId_key" ON "HostRestaurantAssignment"("organizationHostId", "restaurantId");

-- CreateIndex
CREATE INDEX "AuditLog_restaurantId_idx" ON "AuditLog"("restaurantId");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_idx" ON "AuditLog"("actorUserId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "OrganizationHost" ADD CONSTRAINT "OrganizationHost_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationHost" ADD CONSTRAINT "OrganizationHost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostRestaurantAssignment" ADD CONSTRAINT "HostRestaurantAssignment_organizationHostId_fkey" FOREIGN KEY ("organizationHostId") REFERENCES "OrganizationHost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostRestaurantAssignment" ADD CONSTRAINT "HostRestaurantAssignment_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
