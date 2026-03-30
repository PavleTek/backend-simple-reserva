-- Índices únicos parciales para que INSERT ... ON CONFLICT en reservationAnalyticsService.js
-- coincida con una restricción (PostgreSQL 42P10 si no existen).

CREATE UNIQUE INDEX "ReservationAnalytics_date_restaurantId_key"
ON "ReservationAnalytics" ("date", "restaurantId")
WHERE "restaurantId" IS NOT NULL;

CREATE UNIQUE INDEX "ReservationAnalytics_date_global_key"
ON "ReservationAnalytics" ("date")
WHERE "restaurantId" IS NULL;
