'use strict';

/**
 * Idempotente: normaliza Reservation.customerPhone y BookingWaitlistEntry.customerPhone a E.164.
 * No toca centinelas (ya van a null en la migración CAPTURE NOW).
 *
 *   node scripts/backfill-phone-e164.js
 */

require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { normalizePhone, isSentinelPhone } = require('../src/lib/phone');

async function backfillTable(model, idField = 'id') {
  const rows = await prisma[model].findMany({
    where: { customerPhone: { not: null } },
    select: { [idField]: true, customerPhone: true },
  });
  let updated = 0;
  for (const row of rows) {
    const raw = row.customerPhone;
    if (isSentinelPhone(raw)) {
      await prisma[model].update({
        where: { [idField]: row[idField] },
        data: { customerPhone: null },
      });
      updated += 1;
      continue;
    }
    const next = normalizePhone(raw, { defaultCountry: 'CL' });
    if (next && next !== raw) {
      await prisma[model].update({
        where: { [idField]: row[idField] },
        data: { customerPhone: next },
      });
      updated += 1;
    }
  }
  return { scanned: rows.length, updated };
}

async function main() {
  const reservations = await backfillTable('reservation');
  const waitlist = await backfillTable('bookingWaitlistEntry');
  console.log('[backfill-phone-e164]', { reservations, waitlist });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
