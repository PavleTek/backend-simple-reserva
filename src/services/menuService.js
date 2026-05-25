const prisma = require('../lib/prisma');
const r2Service = require('./r2Service');
const { ValidationError } = require('../utils/errors');
const {
  normalizeExternalUrl,
  validateMenuLabel,
} = require('../utils/menuUrlValidation');

const MENU_TYPES = ['pdf', 'link'];

function buildPdfProxyUrl(restaurantId, menuId) {
  return `/api/public/restaurants/id/${restaurantId}/menus/${menuId}/file`;
}

function resolvePublicPdfUrl(restaurantId, menuId, r2Key) {
  const publicUrl = r2Service.getPublicUrl(r2Key);
  return publicUrl || buildPdfProxyUrl(restaurantId, menuId);
}

async function getNextSortOrder(restaurantId) {
  const last = await prisma.restaurantMenu.findFirst({
    where: { restaurantId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  return (last?.sortOrder ?? -1) + 1;
}

async function deleteMenuR2IfPdf(menu) {
  if (menu.type === 'pdf' && menu.r2Key) {
    await r2Service.deleteFile(menu.r2Key).catch((err) => {
      console.error('Error deleting menu from R2:', err);
    });
  }
}

function parseMenuTypeParam(type) {
  const t = (type || '').toLowerCase();
  if (!MENU_TYPES.includes(t)) {
    throw new ValidationError('Tipo de menú no válido. Use pdf o link.');
  }
  return t;
}

module.exports = {
  MENU_TYPES,
  buildPdfProxyUrl,
  resolvePublicPdfUrl,
  getNextSortOrder,
  deleteMenuR2IfPdf,
  parseMenuTypeParam,
  normalizeExternalUrl,
  validateMenuLabel,
};
