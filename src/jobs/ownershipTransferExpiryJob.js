/**
 * Expires pending ownership transfers past their expiresAt.
 */

const cron = require('node-cron');
const logger = require('../lib/logger');
const { withCronLock } = require('../lib/cronLock');
const { expirePendingTransfers } = require('../services/ownershipTransferService');
const { writeAuditLog } = require('../services/auditLogService');
const prisma = require('../lib/prisma');

async function runOwnershipTransferExpiry() {
  try {
    const now = new Date();
    const toExpire = await prisma.ownershipTransfer.findMany({
      where: { status: 'pending', expiresAt: { lt: now } },
      select: { id: true, organizationId: true, targetEmail: true },
    });

    const count = await expirePendingTransfers();
    if (count > 0) {
      logger.info({ count }, '[OwnershipTransferExpiryJob] transfers expired');
      for (const row of toExpire) {
        writeAuditLog({
          action: 'ownership.transfer.expired',
          resourceType: 'ownership_transfer',
          resourceId: row.id,
          metadata: { organizationId: row.organizationId, targetEmail: row.targetEmail },
        }).catch(() => {});
      }
    }
  } catch (err) {
    logger.error({ err }, '[OwnershipTransferExpiryJob] failed');
  }
}

function startOwnershipTransferExpiryJob() {
  const schedule = process.env.OWNERSHIP_TRANSFER_EXPIRY_CRON || '0 * * * *';
  cron.schedule(
    schedule,
    () => {
      withCronLock('ownershipTransferExpiry', runOwnershipTransferExpiry).catch((err) => {
        logger.error({ err }, '[OwnershipTransferExpiryJob] lock/run error');
      });
    },
    { timezone: process.env.TZ || 'America/Santiago' },
  );
  logger.info({ schedule }, '[OwnershipTransferExpiryJob] scheduled');
  runOwnershipTransferExpiry().catch((err) => {
    logger.error({ err }, '[OwnershipTransferExpiryJob] startup run failed');
  });
}

module.exports = { startOwnershipTransferExpiryJob, runOwnershipTransferExpiry };
