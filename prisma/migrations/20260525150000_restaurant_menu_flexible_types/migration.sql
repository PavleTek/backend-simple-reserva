-- RestaurantMenu: flexible labels, pdf | link, no fixed slots

-- Step 1: add new columns (label nullable until backfill)
ALTER TABLE "RestaurantMenu" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'pdf';
ALTER TABLE "RestaurantMenu" ADD COLUMN "label" TEXT;
ALTER TABLE "RestaurantMenu" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RestaurantMenu" ADD COLUMN "visible" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "RestaurantMenu" ADD COLUMN "externalUrl" TEXT;
ALTER TABLE "RestaurantMenu" ADD COLUMN "metadata" JSONB;

-- Step 2: backfill from existing rows (do not touch url, r2Key, fileName, fileSize)
UPDATE "RestaurantMenu" SET
  "type" = 'pdf',
  "label" = CASE "menuType"
    WHEN 'main' THEN 'Menú Principal'
    WHEN 'drinks' THEN 'Carta de Bebidas'
    WHEN 'dessert' THEN 'Carta de Postres'
    ELSE 'Menú'
  END,
  "sortOrder" = CASE "menuType"
    WHEN 'main' THEN 0
    WHEN 'drinks' THEN 1
    WHEN 'dessert' THEN 2
    ELSE 0
  END,
  "visible" = true
WHERE "label" IS NULL;

-- Step 3: label required
ALTER TABLE "RestaurantMenu" ALTER COLUMN "label" SET NOT NULL;

-- Step 4: menuType optional (legacy)
ALTER TABLE "RestaurantMenu" ALTER COLUMN "menuType" DROP NOT NULL;

-- Step 5: PDF fields optional (links have no file)
ALTER TABLE "RestaurantMenu" ALTER COLUMN "fileName" DROP NOT NULL;
ALTER TABLE "RestaurantMenu" ALTER COLUMN "fileSize" DROP NOT NULL;
ALTER TABLE "RestaurantMenu" ALTER COLUMN "r2Key" DROP NOT NULL;

-- Step 6: drop fixed-slot unique constraint and legacy single-column index
DROP INDEX IF EXISTS "RestaurantMenu_restaurantId_menuType_key";
DROP INDEX IF EXISTS "RestaurantMenu_restaurantId_idx";

-- Step 7: index for sort order
CREATE INDEX "RestaurantMenu_restaurantId_sortOrder_idx" ON "RestaurantMenu"("restaurantId", "sortOrder");
