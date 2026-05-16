-- Add isDeleted flag to RestaurantOrganization (soft-delete support)
ALTER TABLE "RestaurantOrganization" ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false;

-- Make ownerId nullable so the org row survives when the owner user is deleted
ALTER TABLE "RestaurantOrganization" ALTER COLUMN "ownerId" DROP NOT NULL;

-- Replace CASCADE FK with SET NULL so deleting the owner user nulls ownerId instead of deleting the org
ALTER TABLE "RestaurantOrganization" DROP CONSTRAINT "RestaurantOrganization_ownerId_fkey";
ALTER TABLE "RestaurantOrganization" ADD CONSTRAINT "RestaurantOrganization_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Index for filtering soft-deleted orgs
CREATE INDEX "RestaurantOrganization_isDeleted_idx" ON "RestaurantOrganization"("isDeleted");

-- Add isDeleted flag to Restaurant (soft-delete support, preserves Reservation rows)
ALTER TABLE "Restaurant" ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false;

-- Index for filtering soft-deleted restaurants
CREATE INDEX "Restaurant_isDeleted_idx" ON "Restaurant"("isDeleted");
