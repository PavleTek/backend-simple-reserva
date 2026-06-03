-- CreateTable
CREATE TABLE "ZoneFixture" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT,
    "posX" INTEGER NOT NULL,
    "posY" INTEGER NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 1,
    "height" INTEGER NOT NULL DEFAULT 1,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZoneFixture_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ZoneFixture_zoneId_idx" ON "ZoneFixture"("zoneId");

-- AddForeignKey
ALTER TABLE "ZoneFixture" ADD CONSTRAINT "ZoneFixture_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
