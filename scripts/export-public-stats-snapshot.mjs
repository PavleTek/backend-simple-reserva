/**
 * Exporta métricas públicas reales a la landing (fallback si /api/public/stats falla).
 * Uso: node scripts/export-public-stats-snapshot.mjs
 */
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPublicStats } from '../src/services/publicStatsService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(
  __dirname,
  '../../user-front-simple-reserva/src/content/landing/publicStatsSnapshot.ts',
);

const stats = await getPublicStats();

const body = `/**
 * Snapshot de métricas reales de la plataforma.
 * Actualizar: cd backend-simple-reserva && node scripts/export-public-stats-snapshot.mjs
 * Generado: ${new Date().toISOString()}
 */
import type { PublicStats } from '@/api/publicStats';

export const PUBLIC_STATS_FALLBACK: PublicStats = ${JSON.stringify(stats, null, 2)} as PublicStats;
`;

writeFileSync(outPath, body, 'utf8');
console.log('OK', outPath);
console.log(JSON.stringify(stats, null, 2));

process.exit(0);
