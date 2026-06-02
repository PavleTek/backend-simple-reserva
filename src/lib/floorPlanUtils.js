/**
 * Utilidades compartidas para el plano de mesas (grilla, solapes, bordes).
 * @param {{ posX: number | null, posY: number | null, width: number, height: number, rotation: number }} t
 */
function effectiveSize(t) {
  let w = t.width ?? 1;
  let h = t.height ?? 1;
  const r = t.rotation ?? 0;
  if (r === 90 || r === 270) {
    return { w: h, h: w };
  }
  return { w, h };
}

/** @returns {Set<string>} claves "x,y" */
function occupiedCellsAt(item, ox, oy) {
  const set = new Set();
  if (ox == null || oy == null) return set;
  const { w, h } = effectiveSize(item);
  for (let dx = 0; dx < w; dx += 1) {
    for (let dy = 0; dy < h; dy += 1) {
      set.add(`${ox + dx},${oy + dy}`);
    }
  }
  return set;
}

function tableOccupiedCells(t) {
  if (t.posX == null || t.posY == null) return new Set();
  return occupiedCellsAt(t, t.posX, t.posY);
}

function itemFitsInGrid(item, gridCols, gridRows) {
  const ox = item.posX;
  const oy = item.posY;
  if (ox == null || oy == null) return true;
  const { w, h } = effectiveSize(item);
  return ox >= 0 && oy >= 0 && ox + w <= gridCols && oy + h <= gridRows;
}

function tableFitsInGrid(t, gridCols, gridRows) {
  if (t.posX == null || t.posY == null) return true;
  return itemFitsInGrid(t, gridCols, gridRows);
}

const ALLOWED_FIXTURE_TYPES = new Set([
  'entrance',
  'exit',
  'bar',
  'kitchen',
  'restroom',
  'reception',
  'terrace',
  'wall',
  'column',
  'label',
]);

/**
 * @param {Array<{ id: string, posX: number | null, posY: number | null, width: number, height: number, rotation: number }>} tables
 * @param {Array<{ posX: number, posY: number, width: number, height: number, rotation: number }>} fixtures
 * @param {number} gridCols
 * @param {number} gridRows
 * @returns {{ ok: boolean, message?: string }}
 */
function validateNoOverlap(tables, gridCols, gridRows, fixtures = []) {
  const global = new Set();

  for (const f of fixtures) {
    if (!itemFitsInGrid(f, gridCols, gridRows)) {
      return { ok: false, message: 'Uno o más elementos del plano quedan fuera de la zona.' };
    }
    const cells = occupiedCellsAt(f, f.posX, f.posY);
    for (const c of cells) {
      if (global.has(c)) {
        return { ok: false, message: 'Los elementos del plano no pueden superponerse.' };
      }
      global.add(c);
    }
  }

  for (const t of tables) {
    if (t.posX == null || t.posY == null) continue;
    if (!tableFitsInGrid(t, gridCols, gridRows)) {
      return { ok: false, message: 'Una o más mesas quedan fuera del plano.' };
    }
    const cells = tableOccupiedCells(t);
    for (const c of cells) {
      if (global.has(c)) {
        return { ok: false, message: 'Las mesas no pueden superponerse con otros elementos.' };
      }
      global.add(c);
    }
  }
  return { ok: true };
}

module.exports = {
  effectiveSize,
  tableOccupiedCells,
  occupiedCellsAt,
  tableFitsInGrid,
  itemFitsInGrid,
  validateNoOverlap,
  ALLOWED_FIXTURE_TYPES,
};
