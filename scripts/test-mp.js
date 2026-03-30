/**
 * Prueba directa de MercadoPago preapproval.
 * Ejecutar: node scripts/test-mp.js
 * Ayuda a aislar si el error es de credenciales o del body.
 */
require('dotenv').config();

const TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const EMAIL = process.env.MP_TEST_PAYER_EMAIL;
const BACK_URL = process.env.BACKEND_PUBLIC_URL || 'https://example.com';

if (!TOKEN) {
  console.error('Falta MERCADOPAGO_ACCESS_TOKEN en .env');
  process.exit(1);
}

if (!EMAIL) {
  console.error('Falta MP_TEST_PAYER_EMAIL en .env (email del comprador de prueba)');
  process.exit(1);
}

const body = {
  reason: 'Test SimpleReserva',
  external_reference: 'test-' + Date.now(),
  payer_email: EMAIL,
  status: 'pending',
  auto_recurring: {
    frequency: 1,
    frequency_type: 'months',
    end_date: '2027-12-31T23:59:59.000Z',
    transaction_amount: 6000,
    currency_id: 'CLP',
  },
  back_url: BACK_URL,
};

console.log('Enviando a MP:');
console.log('  payer_email:', EMAIL);
console.log('  token:', TOKEN.slice(0, 20) + '...');
console.log('  full body:', JSON.stringify(body, null, 2), '\n');

const { MercadoPagoConfig, PreApproval } = require('mercadopago');
const client = new MercadoPagoConfig({ accessToken: TOKEN });
const preApproval = new PreApproval(client);

preApproval
  .create({ body })
  .then((r) => {
    console.log('✅ OK!');
    console.log('  init_point:', r?.init_point || r?.initPoint);
    console.log('  id (preapproval_id):', r?.id);
    console.log('\nAbre esa URL en el navegador con el comprador de prueba logueado en MP.');
  })
  .catch((err) => {
    console.error('❌ Error:', err?.message ?? err);
    console.error('Respuesta MP:', JSON.stringify(err, null, 2));
    process.exit(1);
  });
