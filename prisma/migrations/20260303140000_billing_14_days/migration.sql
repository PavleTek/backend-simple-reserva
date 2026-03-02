-- Change billing from 15 days to 14 days (every 2 weeks)
UPDATE "PlanConfig" SET "billingFrequencyDays" = 14 WHERE "billingFrequencyDays" = 15;
