-- Partial unique indexes required by reservationAnalyticsService.js ON CONFLICT clauses
-- (raw SQL upserts per restaurant day and global aggregate per day).

CREATE UNIQUE INDEX "ReservationAnalytics_date_restaurant_partial_ux"
ON "ReservationAnalytics" ("date", "restaurantId")
WHERE "restaurantId" IS NOT NULL;

CREATE UNIQUE INDEX "ReservationAnalytics_date_global_partial_ux"
ON "ReservationAnalytics" ("date")
WHERE "restaurantId" IS NULL;
