# Billing architecture (SimpleReserva)

> Documentación de producto y operaciones en español: [BILLING_ES.md](./BILLING_ES.md)

## Domain model (SaaS)

Three orthogonal concepts:

| Layer | Field | Values | User-facing label |
|-------|--------|--------|-------------------|
| **Subscription** | `planId` | Plan SKUs | Plan Profesional, frecuencia |
| **Billing strategy** | `billingStrategy` | `automatic_recurring`, `manual_monthly` | Método de cobro |
| **Payment provider (PSP)** | `paymentProvider` | `mercadopago` (future: `paypal`, `stripe`) | Procesado por Mercado Pago |

Plan changes use **`planChangeWhen`**: `immediate` | `end_of_period`. Independent of billing strategy.

Internal MP implementation is stored in `providerImplementation` (`preapproval` | `checkout_pro`) during migration. Legacy API ids `mercadopago_preapproval` / `mp_checkout_pro` are mapped via [`billingDomain.js`](../src/lib/billingDomain.js).

## Access

- **SoT:** `Subscription.isActiveSubscription`
- Scheduled plan changes (manual): `scheduledPlanId`, `scheduledChangeAt` on active subscription
- MP scheduled subs (`status=scheduled`) remain for automatic recurring

## Orchestration

[`billingOrchestrator.js`](../src/services/billing/billingOrchestrator.js) — business actions:

- `executePlanChange` — never blocks by strategy; manual `end_of_period` writes DB only
- `updateCollectionMethod` — change how to charge without changing plan
- `schedulePlanChangeInDb` — manual end-of-period

[`adapters/mercadopagoBillingAdapter.js`](../src/services/billing/adapters/mercadopagoBillingAdapter.js) maps strategy → MP API.

## API (restaurant portal)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/billing/overview` | Resumen (plan, próximo cobro, método de cobro) |
| GET | `/billing/providers` | Legacy provider list + `collectionMethods` |
| GET | `/billing/collection-methods` | Estrategias de cobro |
| POST | `/billing/change-plan/preview` | Preview; body `when`: `immediate` \| `end_of_period` |
| POST | `/billing/change-plan` | Ejecuta cambio; respuesta `{ scheduled: true }` si programación DB |
| POST | `/billing/payment-method/update` | Alias: cambiar método de cobro |
| POST | `/billing/collection-method/update` | Cambiar `billingStrategy` |
| POST | `/billing/recovery/create-link` | Link Checkout Pro en grace |

## Upgrade immediate (manual)

Policy: **full month** of new plan from today (no daily proration). Checkout Pro preference; on approval `activateOrganizationSubscription` resets `currentPeriodEnd`.

## Jobs

- `billingRenewalReminderJob` — renewal reminders 7/4/1 d (`billingStrategy=manual_monthly`)
- `manualPeriodOverdueJob` — manual period expired → grace + email
- `lastChanceLinkJob` — grace last chance (~24h before expiry)
- `planChangeSchedulerJob` — apply `scheduledPlanId` at `scheduledChangeAt`; generate payment link for manual
- `reconciliationJob` — activates MP `scheduled` subs

## Env

- `BILLING_STRATEGIES_ENABLED=automatic_recurring,manual_monthly`
- `BILLING_PROVIDERS_ENABLED` — legacy, still respected
- `PLAN_CHANGE_SCHEDULER_CRON` / `PLAN_CHANGE_SCHEDULER_ENABLED`

## Frontend

Sub-rutas `/billing` con copy **método de cobro** (no “método de pago”). `PlanChangeDialog`: timing + collection method info; no block by strategy.
