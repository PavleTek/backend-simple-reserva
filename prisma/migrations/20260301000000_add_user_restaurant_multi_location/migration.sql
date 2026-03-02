-- CreateTable
CREATE TABLE "UserRestaurant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRestaurant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserRestaurant_userId_restaurantId_key" ON "UserRestaurant"("userId", "restaurantId");

-- CreateIndex
CREATE INDEX "UserRestaurant_userId_idx" ON "UserRestaurant"("userId");

-- CreateIndex
CREATE INDEX "UserRestaurant_restaurantId_idx" ON "UserRestaurant"("restaurantId");

-- AddForeignKey
ALTER TABLE "UserRestaurant" ADD CONSTRAINT "UserRestaurant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRestaurant" ADD CONSTRAINT "UserRestaurant_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing User.restaurantId to UserRestaurant (owner and admin only, not super_admin)
INSERT INTO "UserRestaurant" ("id", "userId", "restaurantId", "role")
SELECT 
    gen_random_uuid()::text,
    "id",
    "restaurantId",
    CASE WHEN "role" = 'owner' THEN 'owner' ELSE 'admin' END
FROM "User"
WHERE "restaurantId" IS NOT NULL
  AND "role" IN ('owner', 'admin');

-- DropForeignKey (User_restaurantId_fkey)
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_restaurantId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "User_restaurantId_idx";

-- DropColumn
ALTER TABLE "User" DROP COLUMN "restaurantId";
