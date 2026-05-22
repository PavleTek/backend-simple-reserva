-- Plan.postVisitFeedback + default sendDelayMinutes 60 for new surveys
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "postVisitFeedback" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Plan" SET "postVisitFeedback" = false WHERE "productSKU" = 'plan-basico';
UPDATE "Plan" SET "postVisitFeedback" = true WHERE "productSKU" IN ('plan-profesional', 'plan-premium');

ALTER TABLE "FeedbackSurvey" ALTER COLUMN "sendDelayMinutes" SET DEFAULT 60;
