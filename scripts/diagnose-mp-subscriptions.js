#!/usr/bin/env node
/**
 * Diagnóstico: ¿puede esta cuenta MP crear suscripciones (POST /preapproval)?
 * Uso: node scripts/diagnose-mp-subscriptions.js [email_pagador]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getMercadoPagoAccessToken, describeMercadoPagoCredentialChoice } = require('../src/lib/mercadopagoEnv');

const TOKEN = getMercadoPagoAccessToken();
const PAYER = process.argv[2] || process.env.MP_TEST_PAYER_EMAIL || '';
const BACK = (process.env.BACKEND_PUBLIC_URL || 'https://www.mercadopago.cl').replace(/\/$/, '');

async function main() {
  console.log('=== Diagnóstico Suscripciones Mercado Pago ===\n');
  console.log('Credenciales:', describeMercadoPagoCredentialChoice());
  if (!TOKEN) {
    console.error('❌ Sin MERCADOPAGO_ACCESS_TOKEN');
    process.exit(1);
  }
  const atHint =
    TOKEN.length < 12 ? '(vacío)' : `${TOKEN.slice(0, 16)}…${TOKEN.slice(-8)}`;
  console.log('Token:', atHint);
  if (!PAYER) {
    console.error('❌ Indica payer_email: node scripts/diagnose-mp-subscriptions.js email@ejemplo.com');
    process.exit(1);
  }
  console.log('payer_email:', PAYER);
  console.log('');

  const meRes = await fetch('https://api.mercadopago.com/users/me', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const me = await meRes.json();
  if (!meRes.ok) {
    console.error('❌ GET /users/me falló:', meRes.status, me);
    process.exit(1);
  }
  console.log('✅ GET /users/me:', { user_id: me.id, site_id: me.site_id, country_id: me.country_id });
  if (me.site_id !== 'MLC') {
    console.warn('⚠️  site_id no es MLC (Chile). Suscripciones en CLP requieren cuenta Chile.');
  }
  console.log('');

  const start = new Date(Date.now() + 3 * 60 * 1000);
  const end = new Date(start);
  end.setFullYear(end.getFullYear() + 10);

  const body = {
    reason: 'Diagnóstico SimpleReserva',
    external_reference: `diag-${Date.now()}`,
    payer_email: PAYER,
    status: 'pending',
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      start_date: start.toISOString(),
      end_date: end.toISOString(),
      transaction_amount: 6000,
      currency_id: 'CLP',
    },
    // back_url = retorno post-checkout (doc MP), no el webhook
    back_url: BACK.includes('localhost') || BACK.includes('127.0.0.1')
      ? 'https://www.mercadopago.cl'
      : `${BACK}/api/redirect-to-billing`,
    notification_url: `${BACK}/api/webhooks/mercadopago`,
  };

  console.log('POST /preapproval …');
  const res = await fetch('https://api.mercadopago.com/preapproval', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();

  if (res.ok) {
    console.log('✅ Suscripción creada OK');
    console.log('   id:', data.id);
    console.log('   init_point:', data.init_point);
    process.exit(0);
  }

  console.error('❌ POST /preapproval falló:', res.status);
  console.error(JSON.stringify(data, null, 2));

  if (String(data.message || '').includes('different countries')) {
    console.error('\n--- Diagnóstico error 106 (país del PAGADOR, no del vendedor) ---');
    console.error(`El vendedor es ${me.site_id}/${me.country_id} (OK para CLP).`);
    console.error(`MP asocia "${PAYER}" a una cuenta de OTRO país (p. ej. Argentina).`);
    console.error('No importa que el correo sea @gmail.com o que vivas en Chile: cuenta el sitio MP del pagador.');
    console.error('\nPrueba rápida (mismo token, email sin cuenta MP extranjera):');
    const synth = `sub-diag-${Date.now()}@simplereserva.cl`;
    const r2 = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, payer_email: synth, external_reference: `diag-synth-${Date.now()}` }),
    });
    const d2 = await r2.json();
    if (r2.ok) {
      console.error(`✅ Con payer_email sintético (${synth}) → ${r2.status} id=${d2.id}`);
      console.error('   → El problema es tu correo como pagador en MP, no las credenciales del vendedor.');
    } else {
      console.error(`❌ Sintético también falló (${r2.status}):`, d2.message || d2);
    }
    console.error('\nQué hacer:');
    console.error('1. Cierra sesión en mercadopago.com / .com.ar / .cl');
    console.error('2. Usa un correo con cuenta en https://www.mercadopago.cl (Chile)');
    console.error('3. En SimpleReserva ese mismo correo va en Facturación → correo Mercado Pago (billingEmail)');
    console.error('4. El email sintético en esta prueba solo demuestra que el vendedor MLC está OK; en producción NO se usa');
  }

  if (data.code === 'PA_UNAUTHORIZED_RESULT_FROM_POLICIES' || data.blocked_by === 'PolicyAgent') {
    console.error('\n--- Qué hacer (no es bug de código) ---');
    console.error('1. Entra a https://www.mercadopago.cl/developers/panel/app');
    console.error('2. Abre tu aplicación SimpleReserva');
    console.error('3. Activa el producto "Suscripciones" / "Planes y suscripciones"');
    console.error('4. Copia Access Token de Producción DE ESA APP (pestaña Credenciales de producción)');
    console.error('5. Ponlo en Railway como MERCADOPAGO_ACCESS_TOKEN_PRODUCTION');
    console.error('6. Si ya está activo: Soporte MP → adjunta este JSON y la hora exacta');
  }
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
