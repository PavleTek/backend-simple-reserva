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
function tableOccupiedCells(t) {
  const set = new Set();
  if (t.posX == null || t.posY == null) return set;
  const { w, h } = effectiveSize(t);
  for (let dx = 0; dx < w; dx += 1) {
    for (let dy = 0; dy < h; dy += 1) {
      set.add(`${t.posX + dx},${t.posY + dy}`);
    }
  }
  return set;
}

function tableFitsInGrid(t, gridCols, gridRows) {
  if (t.posX == null || t.posY == null) return true;
  const { w, h } = effectiveSize(t);
  return t.posX >= 0 && t.posY >= 0 && t.posX + w <= gridCols && t.posY + h <= gridRows;
}

/**
 * @param {Array<{ id: string, posX: number | null, posY: number | null, width: number, height: number, rotation: number }>} tables
 * @param {number} gridCols
 * @param {number} gridRows
 * @returns {{ ok: boolean, message?: string }}
 */
function validateNoOverlap(tables, gridCols, gridRows) {
  const global = new Set();
  for (const t of tables) {
    if (t.posX == null || t.posY == null) continue;
    if (!tableFitsInGrid(t, gridCols, gridRows)) {
      return { ok: false, message: 'Una o más mesas quedan fuera del plano.' };
    }
    const cells = tableOccupiedCells(t);
    for (const c of cells) {
      if (global.has(c)) {
        return { ok: false, message: 'Las mesas no pueden superponerse.' };
      }
      global.add(c);
    }
  }
  return { ok: true };
}

module.exports = {
  effectiveSize,
  tableOccupiedCells,
  tableFitsInGrid,
  validateNoOverlap,
};
