-- AlterTable
ALTER TABLE "Configuration" ADD COLUMN "whatsappAuthToken" TEXT;
ALTER TABLE "Configuration" ADD COLUMN "whatsappSendingPhoneNumberId" TEXT;
ALTER TABLE "Configuration" ADD COLUMN "whatsappBusinessAccountId" TEXT;
ALTER TABLE "Configuration" ADD COLUMN "whatsappApiVersion" TEXT DEFAULT 'v21.0';
ALTER TABLE "Configuration" ADD COLUMN "whatsappTemplateLanguage" TEXT DEFAULT 'es';

-- CreateTable
CREATE TABLE "WhatsAppTemplate" (
    "id" TEXT NOT NULL,
    "metaId" TEXT,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'es',
    "category" TEXT,
    "status" TEXT,
    "bodyText" TEXT,
    "componentsJson" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTemplate_metaId_key" ON "WhatsAppTemplate"("metaId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTemplate_name_language_key" ON "WhatsAppTemplate"("name", "language");

-- CreateIndex
CREATE INDEX "WhatsAppTemplate_status_idx" ON "WhatsAppTemplate"("status");
