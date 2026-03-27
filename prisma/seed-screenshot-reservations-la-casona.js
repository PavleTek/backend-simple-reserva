/**
 * Crea reservas de ejemplo en "La Casona de Pedro" para demos / screenshots.
 * Ejecutar: node prisma/seed-screenshot-reservations-la-casona.js
 *
 * Idempotente por nombre+fecha+hora (no duplica si ya existe).
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { DateTime } = require('luxon');

const prisma = new PrismaClient();

const SLUG = 'la-casona-de-pedro';
const TZ = 'America/Santiago';

const DEMO_RESERVATIONS = [
  // Hoy — almuerzo y tarde
  { dayOffset: 0, time: '12:30', party: 2, customer: 'María López', phone: '+56911223344', tableLabel: 'M1' },
  { dayOffset: 0, time: '13:00', party: 4, customer: 'José Herrera', phone: '+56922334455', tableLabel: 'T1' },
  { dayOffset: 0, time: '13:30', party: 2, customer: 'Francisca Muñoz', phone: '+56933445566', tableLabel: 'T2' },
  { dayOffset: 0, time: '14:00', party: 5, customer: 'Diego Rojas', phone: '+56944556677', tableLabel: 'T3' },
  { dayOffset: 0, time: '14:30', party: 4, customer: 'Valentina Silva', phone: '+56955667788', tableLabel: 'T4' },
  // Hoy — cena
  { dayOffset: 0, time: '19:00', party: 2, customer: 'Andrés Morales', phone: '+56966778899', tableLabel: 'M1' },
  { dayOffset: 0, time: '19:30', party: 4, customer: 'Camila Reyes', phone: '+56977889900', tableLabel: 'T1' },
  { dayOffset: 0, time: '20:00', party: 6, customer: 'Matías Contreras', phone: '+56988990011', tableLabel: 'T5' },
  { dayOffset: 0, time: '20:30', party: 3, customer: 'Sofía Araya', phone: '+56999001122', tableLabel: 'T2' },
  { dayOffset: 0, time: '21:00', party: 2, customer: 'Nicolás Fuentes', phone: '+56900112233', tableLabel: 'M1' },
  // Mañana
  { dayOffset: 1, time: '13:00', party: 4, customer: 'Paula Vega', phone: '+56911220011', tableLabel: 'T4' },
  { dayOffset: 1, time: '19:00', party: 2, customer: 'Rodrigo Pinto', phone: '+56922330022', tableLabel: 'M1' },
  { dayOffset: 1, time: '20:00', party: 8, customer: 'Empresa Altos — Cena equipo', phone: '+56933440033', tableLabel: 'T5' },
];

async function main() {
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug: SLUG },
    include: {
      zones: { where: { isActive: true }, include: { tables: { where: { isActive: true } } } },
    },
  });

  if (!restaurant) {
    console.error(`No existe el restaurante con slug "${SLUG}". Ejecuta: npm run seed`);
    process.exit(1);
  }

  const tableByLabel = new Map();
  for (const z of restaurant.zones) {
    for (const t of z.tables) {
      tableByLabel.set(t.label, t);
    }
  }

  const base = DateTime.now().setZone(TZ).startOf('day');
  let created = 0;
  let skipped = 0;

  for (const row of DEMO_RESERVATIONS) {
    const phone = typeof row.phone === 'number' ? String(row.phone) : row.phone;
    const table = tableByLabel.get(row.tableLabel);
    if (!table) {
      console.warn(`Mesa "${row.tableLabel}" no encontrada — omitiendo ${row.customer}`);
      skipped += 1;
      continue;
    }

    if (row.party < table.minCapacity || row.party > table.maxCapacity) {
      console.warn(
        `Party ${row.party} no cabe en ${row.tableLabel} (${table.minCapacity}-${table.maxCapacity}) — omitiendo ${row.customer}`,
      );
      skipped += 1;
      continue;
    }

    const day = base.plus({ days: row.dayOffset });
    const [h, m] = row.time.split(':').map(Number);
    const dt = day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
    const dateTime = dt.toUTC().toJSDate();

    const exists = await prisma.reservation.findFirst({
      where: {
        restaurantId: restaurant.id,
        customerName: row.customer,
        dateTime,
        status: 'confirmed',
      },
    });
    if (exists) {
      skipped += 1;
      continue;
    }

    await prisma.reservation.create({
      data: {
        restaurantId: restaurant.id,
        tableId: table.id,
        customerName: row.customer,
        customerPhone: phone,
        partySize: row.party,
        dateTime,
        durationMinutes: restaurant.defaultSlotDurationMinutes ?? 60,
        status: 'confirmed',
        source: 'manual',
        notes: 'Demo / screenshots',
      },
    });
    created += 1;
    console.log(`+ ${row.customer} — ${dt.toFormat('ccc d LLL HH:mm')} — Mesa ${row.tableLabel} (${row.party}p)`);
  }

  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: { dataVersion: { increment: 1 } },
  });

  console.log(`\nListo: ${created} reservas creadas, ${skipped} omitidas (ya existían o error de mesa).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
