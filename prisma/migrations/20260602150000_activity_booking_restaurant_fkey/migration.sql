-- ActivityBooking.restaurantId FK (omitted in activities_domain migration)
ALTER TABLE "ActivityBooking" ADD CONSTRAINT "ActivityBooking_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
