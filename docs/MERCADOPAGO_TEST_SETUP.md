# Guía para probar pagos de Mercado Pago (dev)

Basado en la [documentación oficial de Mercado Pago](https://www.mercadopago.cl/developers/en/docs/subscriptions/landing). Sigue estos pasos **en orden**.

---

## Requisito crítico: Token del Vendedor de prueba

> Según la [documentación oficial de credenciales](https://www.mercadopago.cl/developers/en/docs/your-integrations/credentials): para productos como Suscripciones que no tienen credenciales de prueba (TEST-xxx), debes usar las **credenciales de producción de una cuenta de prueba** (Vendedor de prueba).

**El token debe ser del Vendedor de prueba, NO de tu cuenta principal.** Si usas el token de tu cuenta real con un comprador de prueba, MP devuelve "Both payer and collector must be real or test" o error 500.

---

## 1. Crear cuentas de prueba

1. Entra a [Tus integraciones](https://www.mercadopago.cl/developers/panel/app)
2. Inicia sesión con tu cuenta de Mercado Pago (la que creó la app)
3. Selecciona tu aplicación SimpleReserva
4. En el menú izquierdo: **Cuentas de prueba**
5. Clic en **Crear cuenta de prueba**
6. Crea **dos cuentas** (una a la vez):

   **Primera cuenta – Vendedor**
   - Tipo: **Vendedor**
   - País: **Chile**
   - Descripción: `Vendedor SimpleReserva`
   - Crear

   **Segunda cuenta – Comprador**
   - Tipo: **Comprador**
   - País: **Chile**
   - Descripción: `Comprador pruebas`
   - Crear

7. Anota los datos que muestra MP para cada cuenta (Usuario y Contraseña)

---

## 2. Obtener el token del Vendedor de prueba

### Opción A (recomendada): App creada por el Vendedor de prueba

1. **Cierra sesión** y entra a [Tus integraciones](https://www.mercadopago.cl/developers/panel/app) con el **Vendedor de prueba**
2. Clic en **Crear aplicación** (el vendedor no ve tu app SimpleReserva)
3. Nombre: `SimpleReserva Test`, Producto: **Suscripciones**
4. En la app creada: **Pruebas** → **Credenciales de prueba** → copia el Access Token (`TEST-xxx`)

   > Si Subscriptions no ofrece credenciales de prueba, ve a la Opción B.

### Opción B: Credenciales de producción del Vendedor de prueba

1. Inicia sesión en [mercadopago.cl](https://www.mercadopago.cl) con el **Vendedor de prueba**
2. **Tu negocio** → **Configuración** → **Integraciones** → **Credenciales de producción**
3. Copia el **Access Token** (`APP_USR-xxx`)

Ese token va en `MERCADOPAGO_ACCESS_TOKEN`.

---

## 3. Configurar `.env`

En `backend-simple-reserva/.env`:

```env
MERCADOPAGO_ACCESS_TOKEN=APP_USR-xxxxxxxx  # O TEST-xxx si aplica. DEBE ser del Vendedor de prueba
MERCADOPAGO_TEST_MODE=true
MP_TEST_PAYER_EMAIL=usuario_exacto_del_comprador@testuser.com  # Campo "Usuario" del Comprador
BACKEND_PUBLIC_URL=https://tu-url.ngrok-free.app
APP_URL=http://localhost:5175
MP_WEBHOOK_SECRET=xxx  # Desde Webhooks > Configurar notificaciones
```

| Variable | Descripción |
|--------|-------------|
| `MERCADOPAGO_ACCESS_TOKEN` | Token del **Vendedor de prueba** (no de tu cuenta principal) |
| `MP_TEST_PAYER_EMAIL` | Copia exacta del campo "Usuario" del Comprador de prueba |
| `BACKEND_PUBLIC_URL` | Tu URL de ngrok (sin barra final) |
| `MP_WEBHOOK_SECRET` | Secret de Webhooks en Tus integraciones |

Reinicia el backend después de cambiar el .env.

---

## 4. Webhook (crítico para activar el plan tras el pago)

Para **suscripciones**, MP no usa la URL configurada en el panel. La app envía `notification_url` en cada preapproval creado (usando `BACKEND_PUBLIC_URL`).

1. Inicia ngrok: `ngrok http 3000` (debe estar **antes** de pagar)
2. Copia la URL (ej: `https://abc123.ngrok-free.app`) y ponla en `BACKEND_PUBLIC_URL` en `.env`
3. Entra a [Tus integraciones](https://www.mercadopago.cl/developers/panel/app) con tu cuenta principal
4. Tu app SimpleReserva → **Webhooks** → **Configurar notificaciones**
5. URL de producción: `https://TU-URL-NGROK/api/webhooks/mercadopago` (sin barra final)
6. Activa **Planes y suscripciones** (`subscription_preapproval`)
7. Guarda y copia el secret a `MP_WEBHOOK_SECRET`

**Si sigues en "Procesando" tras pagar:**
- Mira los logs del backend: deberías ver `[Webhook] MercadoPago received:` cuando MP envía el evento
- Si no aparece nada: la URL del webhook está mal, ngrok cambió, o MP no envía a localhost
- Si ves "signature validation failed": deja `MP_WEBHOOK_SECRET` vacío temporalmente para probar

> Configura la URL del webhook en el panel. Suscripciones: evento "Planes y suscripciones".

---

## 5. Probar el pago

1. Usa ventana de **incógnito** (o cierra sesión de MP)
2. Entra a tu app: `http://localhost:5175`
3. Inicia sesión como owner de un restaurante
4. Ve a **Facturación** y elige un plan
5. Serás redirigido al checkout de Mercado Pago
6. **Inicia sesión con el COMPRADOR de prueba** (email = MP_TEST_PAYER_EMAIL)
7. Tarjeta de prueba: `5031 7557 3453 0604`, CVV `123`, vencimiento futura
8. Confirma → vuelves a la app y la suscripción debe estar activa

---

## Tarjetas de prueba Chile

| Resultado | Número           | CVV |
|----------|------------------|-----|
| Aprobada | 5031 7557 3453 0604 | 123 |
| Aprobada | 4509 9535 6623 3704 | 123 |
| Rechazada | 5031 4332 1540 6351 | 123 |

Más en: [Tarjetas de prueba](https://www.mercadopago.cl/developers/en/docs/your-integrations/test/cards)

---

## Probar credenciales (si sigue 500)

Ejecuta:

```bash
cd backend-simple-reserva
node scripts/test-mp.js
```

- **400 "Cannot pay an amount lower than $ 950.00"**: credenciales OK, MP exige mínimo 950 CLP.
- **500 Internal server error**: casi siempre el token **no** es del Vendedor de prueba.

**Solución al 500:**

1. Cierra sesión en [mercadopago.cl](https://www.mercadopago.cl).
2. **Inicia sesión con el Vendedor de prueba** (Usuario/contraseña que te dio MP al crear la cuenta).
3. Ve a **Tu negocio** → **Configuración** → **Integraciones** → **Credenciales de producción**.
4. Copia el Access Token (`APP_USR-xxx`) y ponlo en `MERCADOPAGO_ACCESS_TOKEN`.
5. Reinicia el backend y vuelve a ejecutar `node scripts/test-mp.js`.

Si sigue 500, puede que la app del Vendedor no tenga Suscripciones habilitado. Crea una app en [Tus integraciones](https://www.mercadopago.cl/developers/panel/app) con el Vendedor de prueba, activa Suscripciones y usa ese token.

---

## Errores frecuentes (docs oficiales)

| Error | Causa | Solución |
|-------|------|----------|
| 500 Internal server error | Token/email mal configurados o parámetro inválido | Token del Vendedor de prueba + MP_TEST_PAYER_EMAIL del Comprador. Usamos biweekly (`days`, 14); si falla, reintentamos con `months`. |
| "Both payer and collector must be real or test" | Token y payer de distinto tipo (uno real, otro prueba) | Token **del Vendedor de prueba** + MP_TEST_PAYER_EMAIL **del Comprador de prueba** |
| "Tu e-mail no coincide con el de la suscripción" | Iniciaste sesión en checkout con otra cuenta | Inicia sesión con el Comprador de prueba (email = MP_TEST_PAYER_EMAIL) |
| "Una de las partes es de prueba" | Mezcla de cuentas reales y de prueba | Ambos (vendedor + comprador) deben ser cuentas de prueba |
| "back_url is required" / "Invalid URL" | URL no accesible | `BACKEND_PUBLIC_URL` con ngrok. ngrok debe estar corriendo. |
| "Cannot operate between different countries" | País distinto | Crea Vendedor y Comprador ambos en **Chile** |
| La suscripción no se activa | Webhook no llega o falla validación | ngrok activo, URL correcta, MP_WEBHOOK_SECRET configurado |

---

## Checklist rápido

- [ ] Vendedor de prueba creado (Chile)
- [ ] Comprador de prueba creado (Chile)
- [ ] Token **del Vendedor de prueba** en `MERCADOPAGO_ACCESS_TOKEN`
- [ ] `MP_TEST_PAYER_EMAIL` = Usuario exacto del Comprador
- [ ] `BACKEND_PUBLIC_URL` = URL de ngrok (sin barra final)
- [ ] ngrok corriendo en puerto 3000
- [ ] Webhook configurado en Tus integraciones
- [ ] Prueba en incógnito
- [ ] Login en checkout con Comprador de prueba
- [ ] Tarjeta 5031 7557 3453 0604

---

## Referencias oficiales

- [Subscriptions](https://www.mercadopago.cl/developers/en/docs/subscriptions/landing)
- [Crear suscripción sin plan](https://www.mercadopago.cl/developers/en/docs/subscriptions/integration-configuration/subscription-no-associated-plan/pending-payments)
- [Cuentas de prueba](https://www.mercadopago.cl/developers/en/docs/your-integrations/test/accounts)
- [Credenciales](https://www.mercadopago.cl/developers/en/docs/your-integrations/credentials)
- [Webhooks](https://www.mercadopago.cl/developers/en/docs/your-integrations/notifications/webhooks)
