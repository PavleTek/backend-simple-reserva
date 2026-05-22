const prisma = require('../lib/prisma');

/**
 * Best-effort audit trail for sensitive actions (non-blocking).
 */
async function writeAuditLog({
  actorUserId = null,
  restaurantId = null,
  action,
  resourceType = null,
  resourceId = null,
  metadata = null,
}) {
  if (!action) return;
  try {
    await prisma.auditLog.create({
      data: {
        actorUserId,
        restaurantId,
        action,
        resourceType,
        resourceId,
        metadata: metadata ?? undefined,
      },
    });
  } catch (err) {
    console.error('[AuditLog] Failed to write:', err.message);
  }
}

module.exports = { writeAuditLog };
