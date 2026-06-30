-- Track day-before reminder email to guest (comensal)
ALTER TABLE "Reservation" ADD COLUMN "reminderEmailSent" BOOLEAN NOT NULL DEFAULT false;
