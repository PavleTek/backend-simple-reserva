# Flow subscription integration (SimpleReserva)

SimpleReserva bills **new** organizations through **Flow.cl managed subscriptions**. Existing organizations stay on Mercado Pago until an admin switches them.

Flow orgs only use **automatic recurring** (card on file). Manual monthly Checkout Pro remains Mercado Pago–only.

Access after a failed charge follows the existing Reserva model: `enterGracePeriod` + `gracePeriodExpiryJob`.

## Shared Flow account with SimpleHora

Both apps use the **same** Flow API key / secret. Identifiers must not collide:

| App | Flow `planId` prefix | Customer `externalId` | Plan `name` |
|-----|----------------------|-----------------------|-------------|
| SimpleHora | `sh` | `sagenda\|{orgId}` | `SimpleHora …` |
| SimpleReserva | `sr` | `sreserva\|{orgId}` | `SimpleReserva {plan.name}` |

Each Flow plan’s `urlCallback` points at **this** backend (`{BACKEND_PUBLIC_URL}/api/webhooks/flow`), so invoice notifications stay on the correct app.

## Provider switch

Provider is **per organization** (`RestaurantOrganization.paymentProvider`), not a global env flag.

| Source | Value |
|--------|--------|
| New org (DB default after migration) | `flow` |
| Existing orgs (migration backfill) | `mercadopago` |
| Admin | `POST /api/admin/organizations/:id/payment-provider` `{ paymentProvider: "flow" \| "mercadopago" }` |

Admin MP → Flow: cancel MP preapproval (best effort), keep local access until the paid period ends (same as `/billing/cancel`). The owner then enrolls a Flow card from the restaurant portal.

## Env

| Variable | Notes |
|----------|--------|
| `FLOW_API_KEY_PRODUCTION` / `FLOW_SECRET_KEY_PRODUCTION` | Same Flow commerce as SimpleHora |
| `BACKEND_PUBLIC_URL` | Webhook + card-enrollment `url_return` |
| `FRONTEND_RESTAURANT_PORTAL_URL` | Redirect after enrollment |

## Mapping

| SimpleReserva | Flow |
|---------------|------|
| `RestaurantOrganization` | `customer` (`externalId` = `sreserva\|{orgId}`) |
| Local `Plan` + amount + interval | `plans/create` `planId` = `sr` + sha256(SKU\|amount\|interval\|count) |
| Checkout | `customer/register` (card enrollment) |
| Paid `Subscription` | `subscription/create` |
| Monthly charge | Flow invoice, webhook → `payment/getStatus` |

Amount sent to Flow = `round(montoEfectivoNeto(org, plan.priceCLP) * 1.19)` (min 950 CLP), same as Mercado Pago.

**Limitation:** add-on changes after subscribe do not re-price an existing Flow subscription (Flow plan amount is fixed).

## Checkout

1. Portal `POST /api/restaurant/:id/billing/checkout`.
2. Backend ensures Flow customer + Flow plan.
3. If the org has no enrolled card → `customer/register` → `checkoutUrl`.
4. Flow POSTs `token` to `{BACKEND_PUBLIC_URL}/api/billing/flow/register-return/:restaurantId`.
5. Backend redirects to `{FRONTEND_RESTAURANT_PORTAL_URL}/billing?returnFromCheckout=1&flowToken=…`.
6. Portal `POST /billing/confirm` `{ flowToken }` → `customer/getRegisterStatus` → `subscription/create`.

If a card is already enrolled, change-plan skips the redirect and creates the new Flow subscription server-side (`checkoutUrl` omitted).

Plan change = cancel previous Flow subscription + create a new one.

## Webhook

`POST {BACKEND_PUBLIC_URL}/api/webhooks/flow` — form-urlencoded `{ token }`.

1. Respond 200 immediately.
2. Persist idempotent `WebhookEvent` (`provider=flow`, `mpEventType=flow_payment`, `mpDataId=token`).
3. Verify with `GET /payment/getStatus`.
4. Status `2` (paid) → `PaymentReceipt` (`provider=flow`, `mercadopagoStatus=approved`), clear grace, advance `currentPeriodEnd`.
5. Status `3`/`4` (rejected/cancelled) on an active sub → `enterGracePeriod`.

## Reconciliation

`runFlowReconciliation` runs before the MP pass:

- Expire stale Flow checkout sessions (or confirm if the card was enrolled).
- `subscription/get` for local subs with `flowSubscriptionId`.
- Retry failed Flow webhook events from the last 48h.

## Checklist

1. Same Flow API key + secret as SimpleHora (`FLOW_API_KEY_PRODUCTION` / `FLOW_SECRET_KEY_PRODUCTION`).
2. `BACKEND_PUBLIC_URL` must be reachable by Flow.
3. Register a **new** org (defaults to Flow) → checkout → enroll a card → first invoice.
4. Change plan with enrolled card → no redirect.
5. Cancel at period end (`at_period_end=1`).
6. Admin-switch a Mercado Pago org → Flow; owner enrolls a card.
7. Confirm legacy Mercado Pago orgs are untouched.
