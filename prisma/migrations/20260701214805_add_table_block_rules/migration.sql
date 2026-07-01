-- CreateTable
CREATE TABLE "TableBlockRule" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "triggerTableId" TEXT NOT NULL,
    "blockedTableId" TEXT NOT NULL,
    "minPartySize" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TableBlockRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TableBlockRule_restaurantId_idx" ON "TableBlockRule"("restaurantId");

-- CreateIndex
CREATE INDEX "TableBlockRule_blockedTableId_idx" ON "TableBlockRule"("blockedTableId");

-- CreateIndex
CREATE UNIQUE INDEX "TableBlockRule_triggerTableId_blockedTableId_key" ON "TableBlockRule"("triggerTableId", "blockedTableId");

-- AddForeignKey
ALTER TABLE "TableBlockRule" ADD CONSTRAINT "TableBlockRule_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableBlockRule" ADD CONSTRAINT "TableBlockRule_triggerTableId_fkey" FOREIGN KEY ("triggerTableId") REFERENCES "RestaurantTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableBlockRule" ADD CONSTRAINT "TableBlockRule_blockedTableId_fkey" FOREIGN KEY ("blockedTableId") REFERENCES "RestaurantTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
