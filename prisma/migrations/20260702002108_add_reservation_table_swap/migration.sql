-- CreateTable
CREATE TABLE "ReservationTableSwap" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "originalTableId" TEXT NOT NULL,
    "substituteTableId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservationTableSwap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReservationTableSwap_reservationId_idx" ON "ReservationTableSwap"("reservationId");

-- CreateIndex
CREATE INDEX "ReservationTableSwap_substituteTableId_idx" ON "ReservationTableSwap"("substituteTableId");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationTableSwap_reservationId_originalTableId_key" ON "ReservationTableSwap"("reservationId", "originalTableId");

-- AddForeignKey
ALTER TABLE "ReservationTableSwap" ADD CONSTRAINT "ReservationTableSwap_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationTableSwap" ADD CONSTRAINT "ReservationTableSwap_originalTableId_fkey" FOREIGN KEY ("originalTableId") REFERENCES "RestaurantTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationTableSwap" ADD CONSTRAINT "ReservationTableSwap_substituteTableId_fkey" FOREIGN KEY ("substituteTableId") REFERENCES "RestaurantTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
