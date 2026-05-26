-- Enable reservation alert emails for owner + all managers/hosts assigned to each local.
-- Preserves existing extra emails on the restaurant when present; otherwise falls back to org custom email.

WITH member_lists AS (
  SELECT
    r.id AS restaurant_id,
    COALESCE(
      (
        SELECT jsonb_object_agg(sub.user_id, to_jsonb(true))
        FROM (
          SELECT om."userId" AS user_id
          FROM "OrganizationManager" om
          INNER JOIN "ManagerRestaurantAssignment" mra ON mra."organizationManagerId" = om.id
          WHERE mra."restaurantId" = r.id
          UNION
          SELECT oh."userId" AS user_id
          FROM "OrganizationHost" oh
          INNER JOIN "HostRestaurantAssignment" hra ON hra."organizationHostId" = oh.id
          WHERE hra."restaurantId" = r.id
        ) sub
      ),
      '{}'::jsonb
    ) AS members
  FROM "Restaurant" r
  WHERE r."isDeleted" = false
),
configs AS (
  SELECT
    r.id AS restaurant_id,
    jsonb_build_object(
      'owner', (o."ownerId" IS NOT NULL),
      'members', ml.members,
      'extras',
      CASE
        WHEN r."reservationNotifyRecipients" IS NOT NULL
          AND jsonb_typeof(r."reservationNotifyRecipients"->'extras') = 'array'
          AND jsonb_array_length(r."reservationNotifyRecipients"->'extras') > 0
        THEN r."reservationNotifyRecipients"->'extras'
        WHEN o."reservationNotifyCustomEmail" IS NOT NULL
          AND btrim(o."reservationNotifyCustomEmail") <> ''
        THEN jsonb_build_array(lower(btrim(o."reservationNotifyCustomEmail")))
        ELSE '[]'::jsonb
      END
    ) AS recipients
  FROM "Restaurant" r
  INNER JOIN "RestaurantOrganization" o ON o.id = r."organizationId"
  INNER JOIN member_lists ml ON ml.restaurant_id = r.id
  WHERE r."isDeleted" = false
)
UPDATE "Restaurant" r
SET
  "reservationNotifyRecipients" = c.recipients,
  "reservationNotifyOnWeb" = true,
  "reservationNotifyOnManual" = true
FROM configs c
WHERE r.id = c.restaurant_id;

-- Keep org legacy fields aligned (owner + all team toggles) for reference / tooling.
UPDATE "RestaurantOrganization" o
SET
  "reservationNotifyAudience" = 'all',
  "reservationNotifyOnWeb" = true,
  "reservationNotifyOnManual" = true,
  "reservationNotifyRecipients" = jsonb_build_object(
    'owner', (o."ownerId" IS NOT NULL),
    'members',
    COALESCE(
      (
        SELECT jsonb_object_agg(sub.user_id, to_jsonb(true))
        FROM (
          SELECT om."userId" AS user_id
          FROM "OrganizationManager" om
          WHERE om."organizationId" = o.id
          UNION
          SELECT oh."userId" AS user_id
          FROM "OrganizationHost" oh
          WHERE oh."organizationId" = o.id
        ) sub
      ),
      '{}'::jsonb
    ),
    'extras',
    CASE
      WHEN o."reservationNotifyCustomEmail" IS NOT NULL
        AND btrim(o."reservationNotifyCustomEmail") <> ''
      THEN jsonb_build_array(lower(btrim(o."reservationNotifyCustomEmail")))
      WHEN o."reservationNotifyRecipients" IS NOT NULL
        AND jsonb_typeof(o."reservationNotifyRecipients"->'extras') = 'array'
        AND jsonb_array_length(o."reservationNotifyRecipients"->'extras') > 0
      THEN o."reservationNotifyRecipients"->'extras'
      ELSE '[]'::jsonb
    END
  )
WHERE o."isDeleted" = false;
