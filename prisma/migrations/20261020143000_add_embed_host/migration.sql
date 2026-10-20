-- Hostname del sitio del local cuando la reserva entra por el embed.

ALTER TABLE "Reservation" ADD COLUMN "embedHost" TEXT;

ALTER TABLE "ActivityBooking" ADD COLUMN "embedHost" TEXT;
