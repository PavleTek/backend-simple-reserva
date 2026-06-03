-- Qué incluye la actividad (lista separada de la descripción narrativa)
ALTER TABLE "Activity" ADD COLUMN IF NOT EXISTS "includes" TEXT;
