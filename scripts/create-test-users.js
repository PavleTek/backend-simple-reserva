/**
 * Crea las cuentas de prueba (vendedor + comprador) necesarias para testear
 * suscripciones en Mercado Pago Chile.
 *
 * ANTES DE CORRER:
 *   Agrega en .env (o como variable de entorno):
 *     MP_PROD_TOKEN=APP_USR-XXXXXXX...   ← tu token de PRODUCCIÓN (real, no TEST-)
 *
 * CORRER:
 *   node scripts/create-test-users.js
 *
 * QUÉ HACE:
 *   1. Crea usuario de prueba VENDEDOR (collector) → guarda sus credenciales TEST-
 *   2. Crea usuario de prueba COMPRADOR (payer)    → guarda su email
 *   3. Imprime qué valores poner en .env
 *
 * DESPUÉS:
 *   - MERCADOPAGO_ACCESS_TOKEN = TEST- token del VENDEDOR de prueba
 *   - MP_PUBLIC_KEY            = TEST- public key del VENDEDOR de prueba
 *   - MP_TEST_PAYER_EMAIL      = email del COMPRADOR de prueba
 *
 * REFERENCIA: https://www.mercadopago.cl/developers/es/docs/subscriptions/additional-content/testing/test-accounts
 */

require('dotenv').config();

const PROD_TOKEN = process.env.MP_PROD_TOKEN;

if (!PROD_TOKEN) {
  console.error(`
ERROR: Falta MP_PROD_TOKEN en .env

Pasos:
  1. Ve a https://www.mercadopago.cl/developers/panel/app
  2. Selecciona tu aplicación
  3. Credenciales de PRODUCCIÓN (APP_USR-...)
  4. Copia el Access Token de producción
  5. Agrégalo a .env:
       MP_PROD_TOKEN=APP_USR-xxxxxxxxxxxxx
  6. Vuelve a correr: node scripts/create-test-users.js
`);
  process.exit(1);
}

if (PROD_TOKEN.startsWith('TEST-')) {
  console.error(`
ERROR: MP_PROD_TOKEN debe ser el token de PRODUCCIÓN (APP_USR-...), no el de prueba (TEST-).

El token TEST- de tu cuenta real no puede crear test users.
Necesitas el APP_USR- de producción de la misma aplicación.
`);
  process.exit(1);
}

async function createTestUser(role) {
  const res = await fetch('https://api.mercadopago.com/users/test_user', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PROD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ site_id: 'MLC' }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Error creando ${role}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function getTestUserCredentials(email, password) {
  // Obtener token de prueba del vendedor vía OAuth password grant
  // NOTA: MP no expone este endpoint directamente; hay que entrar con el usuario de prueba
  // en el panel y obtener sus credenciales TEST- manualmente.
  return null;
}

async function main() {
  console.log('Creando cuentas de prueba en Mercado Pago Chile (MLC)...\n');

  let vendedor, comprador;

  try {
    console.log('1. Creando vendedor de prueba...');
    vendedor = await createTestUser('vendedor');
    console.log('   ✓ Vendedor creado:', {
      id: vendedor.id,
      email: vendedor.email,
      nickname: vendedor.nickname,
    });
  } catch (e) {
    console.error('   ✗', e.message);
    process.exit(1);
  }

  try {
    console.log('2. Creando comprador de prueba...');
    comprador = await createTestUser('comprador');
    console.log('   ✓ Comprador creado:', {
      id: comprador.id,
      email: comprador.email,
      nickname: comprador.nickname,
    });
  } catch (e) {
    console.error('   ✗', e.message);
    process.exit(1);
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ CUENTAS DE PRUEBA CREADAS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

VENDEDOR DE PRUEBA (collector)
  Email:    ${vendedor.email}
  Password: ${vendedor.password}
  ID:       ${vendedor.id}

COMPRADOR DE PRUEBA (payer)
  Email:    ${comprador.email}
  Password: ${comprador.password}
  ID:       ${comprador.id}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRÓXIMO PASO — obtener credenciales TEST del VENDEDOR:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Abre mercadopago.cl en ventana incógnita
2. Inicia sesión con el VENDEDOR de prueba:
     Email:    ${vendedor.email}
     Password: ${vendedor.password}
3. Ve a: https://www.mercadopago.cl/developers/panel/app
4. Crea (o usa) una aplicación
5. En "Credenciales de prueba" copia:
     - Access Token (TEST-...)
     - Public Key   (TEST-...)

6. Actualiza tu .env con:
     MERCADOPAGO_ACCESS_TOKEN=TEST-... (del vendedor de prueba)
     MP_PUBLIC_KEY=TEST-...            (del vendedor de prueba)
     MP_TEST_PAYER_EMAIL=${comprador.email}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
En el checkout de MP, inicia sesión con:
  ${comprador.email} / ${comprador.password}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

main().catch((e) => {
  console.error('Error inesperado:', e.message);
  process.exit(1);
});
