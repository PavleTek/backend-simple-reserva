'use strict';

/**
 * Integración boleta electrónica SII — scaffold.
 * Requiere certificado digital, folios y homologación con el SII.
 * @see https://www.sii.cl/factura_electronica/
 */

const SII_ENABLED = process.env.SII_BOLETA_ENABLED === 'true';

async function issueLegalReceipt(_receipt, _organization) {
  if (!SII_ENABLED) {
    return {
      issued: false,
      reason: 'SII_BOLETA_ENABLED no está activo. Usa comprobante interno PDF.',
    };
  }
  throw new Error('Integración SII pendiente de homologación y certificado digital.');
}

module.exports = {
  SII_ENABLED,
  issueLegalReceipt,
};
