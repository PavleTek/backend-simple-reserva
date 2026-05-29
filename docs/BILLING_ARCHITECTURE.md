# Billing architecture (SimpleReserva)

## Overview

- **Access SoT:** `Subscription.isActiveSubscription`
- **Providers:** `mercadopago_preapproval` (CL auto-debit), `mp_checkout_pro` (manual link / international)
- **Country:** `RestaurantOrganization.billingCountry` — non-CL orgs only see Checkout Pro

## API (restaurant portal)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/billing/overview` | Resumen premium (next charge, alerts, recent invoices) |
| GET | `/billing/providers` | Proveedores filtrados por país |
| POST | `/billing/change-plan/preview` | Preview antes de confirmar |
| POST | `/billing/recovery/create-link` | Link Checkout Pro en grace |
| POST | `/billing/payment-method/update` | Cambiar método sin cambiar plan |
| GET | `/billing/invoices/:id/pdf` | PDF/HTML comprobante |

## Frontend

Sub-rutas bajo `/billing` con `BillingLayout` + React Query.

## Jobs

- `checkoutProRenewalJob` — recordatorio renovación CP
- `lastChanceLinkJob` — link 24h antes de expirar grace
- `backfillPaymentMethodJob` — snapshot tarjeta desde MP

## Env

- `BILLING_PAUSE_ENABLED` — pausa de suscripción
- `SII_BOLETA_ENABLED` — scaffold boleta SII
- `MERCADOPAGO_ACCESS_TOKEN_PRODUCTION_NEW` — rotación rolling
- `BILLING_CANCEL_ANALYTICS_ENABLED` + `MIXPANEL_TOKEN`
