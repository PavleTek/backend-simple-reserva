# Plans and Subscriptions — System Documentation

This document explains how plans, subscriptions, and billing work across all repos in the SimpleReserva monorepo.

---

## Table of contents

1. [Plan model and plan tiers](#1-plan-model-and-plan-tiers)
2. [How plans differ](#2-how-plans-differ)
3. [Custom plans](#3-custom-plans)
4. [Subscription model](#4-subscription-model)
5. [Subscription lifecycle](#5-subscription-lifecycle)
6. [What happens when someone registers](#6-what-happens-when-someone-registers)
7. [What happens when someone buys a plan](#7-what-happens-when-someone-buys-a-plan)
8. [What happens when someone changes plans](#8-what-happens-when-someone-changes-plans)
9. [Billing cycles and period math](#9-billing-cycles-and-period-math)
10. [Grace period](#10-grace-period)
11. [Feature gating — where and how it is enforced](#11-feature-gating--where-and-how-it-is-enforced)
12. [Where plan data is stored](#12-where-plan-data-is-stored)
13. [Admin operations](#13-admin-operations)
14. [Cron jobs](#14-cron-jobs)
15. [Key files per repo](#15-key-files-per-repo)

---

## 1. Plan model and plan tiers

Plans are stored in the `Plan` table in Postgres (managed by Prisma). The canonical configuration lives in the database, not hardcoded in the app — any price or limit change made by the admin in the Plans page takes effect immediately.

Three default public plans ship via `prisma/seed.js` (`isDefault: true`). A fallback config in `planService.js` mirrors these for use when the DB is unreachable:

| Field | plan-basico | plan-profesional | plan-premium |
|-------|-------------|------------------|--------------|
| `name` | Básico | Profesional | Premium |
| `maxRestaurants` | 1 | 3 | 20 |
| `maxZonesPerRestaurant` | 3 | null (unlimited) | null |
| `maxTables` | 15 | null | null |
| `maxTeamMembers` | 2 | 5 | null |
| `whatsappFeatures` | false | false | true |
| `multipleMenu` | false | true | true |
| `googleReserveIntegration` | false | true | true |
| `prioritySupport` | false | false | true |
| `priceCLP` | 9,990 | 14,990 | 39,990 |
| `freeTrialLength` | 14 | 0 | 0 |
| `freeTrialLengthUnit` | days | — | — |
| `billingFrequency` | 1 | 1 | 1 |
| `billingFrequencyType` | months | months | months |

> **Note:** Only `plan-basico` includes a free trial. The other plans activate immediately on purchase.

---

## 2. How plans differ

### Quantity limits

Limits are enforced server-side in `planService.js` via dedicated check functions:

- `canAddLocation(ownerId)` — checks `maxRestaurants` vs current `Restaurant` count
- `canAddZone(restaurantId)` — checks `maxZonesPerRestaurant` vs current `Zone` count
- `canAddTable(restaurantId)` — checks `maxTables` vs total `RestaurantTable` count across all zones in the restaurant
- `canAddTeamMember(ownerId, restaurantId)` — checks `maxTeamMembers` vs `OrganizationManager` count assigned to that restaurant

`null` on any limit means **unlimited**.

### Feature flags

| Flag | What it gates |
|------|---------------|
| `whatsappFeatures` | WhatsApp confirmation and reminder notifications via `notificationService.js` |
| `multipleMenu` | Uploading more than one menu type (drinks, desserts) in `menu.routes.js` |
| `googleReserveIntegration` | Stored on the plan; no additional server-side check in current code beyond data exposure |
| `prioritySupport` | Stored on the plan; surfaced in billing UI, no additional server-side check |

---

## 3. Custom plans

An admin can create non-default `Plan` rows (`isDefault: false`) and assign them to a specific organization using `RestaurantOrganization.customPlanId`.

- A custom plan appears in the restaurant's billing page (`/billing`) alongside public plans, allowing the organization to subscribe to it via Mercado Pago.
- Custom plans are useful for negotiated pricing, special limits, or white-label clients.
- Assignment: `POST /api/admin/organizations/:organizationId/assign-plan` with `{ planId }` or `{ planId: null }` to remove.
- Setting a custom plan only **makes it available** in the billing dropdown — it does not automatically subscribe the org to that plan. The org must still complete checkout.

---

## 4. Subscription model

```
Subscription {
  id
  organizationId         → RestaurantOrganization
  planId                 → Plan (the plan this subscription is on)
  status                 "trial" | "active" | "grace" | "cancelled" | "cancelled_by_admin" | "expired" | "scheduled"
                         INFORMATIONAL ONLY — never used to determine access
  isActiveSubscription   Boolean — the SINGLE source of truth for feature access
                         true  = organization can use all platform features
                         false = organization has no access
  startDate              When this subscription period started
  endDate                End of the paid billing period (informational; used to set gracePeriodEndsAt on cancellation)
  currentPeriodEnd       End of the current Mercado Pago billing cycle
  gracePeriodEndsAt      Deactivation deadline:
                           • payment failure → now + 7 days
                           • manual cancellation → set equal to endDate
                         gracePeriodExpiryJob sets isActiveSubscription = false when this passes
  mercadopagoPreapprovalId  MP subscription ID when paid
  createdAt
}
```

`RestaurantOrganization` also holds:

- `planId` — the effective plan used for feature resolution (kept in sync with the active subscription's plan)
- `trialEndsAt` — set at registration, cleared when the first paid subscription activates (informational for UI/emails)
- `customPlanId` — optional admin-assigned custom plan (controls which plans are shown in billing)

### The access rule

```
hasAccess = Subscription.isActiveSubscription === true
```

Nothing else. No status checks, no date comparisons at query time.

---

## 5. Subscription lifecycle

```
Registration
    │
    ▼
Org created (planId = plan-basico, trialEndsAt = now + 14 days)
Subscription created (status = "trial", isActiveSubscription = true)
    │
    ├─ user pays via MercadoPago ──────────────────────────────────────┐
    │                                                                   ▼
    │                                              Webhook: preapproval authorized
    │                                              → activateOrganizationSubscription()
    │                                              → Old subs cancelled (isActiveSubscription = false)
    │                                              → New Subscription (status = "active", isActiveSubscription = true)
    │                                              → Org.planId = paid plan, trialEndsAt = null
    │                                                   │
    │                                                   ├─ payment renews ──→ currentPeriodEnd updated
    │                                                   │
    │                                                   ├─ payment fails ───→ status = "grace"
    │                                                   │                     gracePeriodEndsAt = now + 7d
    │                                                   │                     isActiveSubscription stays TRUE
    │                                                   │                          │
    │                                                   │                          ├─ payment retried OK
    │                                                   │                          │  → status = "active", gracePeriodEndsAt = null
    │                                                   │                          │
    │                                                   │                          └─ grace expires (gracePeriodExpiryJob)
    │                                                   │                             → isActiveSubscription = false, status = "expired"
    │                                                   │
    │                                                   └─ user cancels ──→ status = "cancelled"
    │                                                                        endDate = periodEnd
    │                                                                        gracePeriodEndsAt = periodEnd (= endDate)
    │                                                                        isActiveSubscription stays TRUE
    │                                                                             │
    │                                                                             └─ periodEnd passes (gracePeriodExpiryJob)
    │                                                                                → isActiveSubscription = false, status = "expired"
    │
    └─ trial period ends without payment (trialExpiryJob)
       → isActiveSubscription = false, status = "expired"
```

### Status definitions (informational only)

| Status | `isActiveSubscription` set by | Notes |
|--------|-------------------------------|-------|
| `trial` | `true` on create | Active during trial period |
| `active` | `true` on activation | Full paid access |
| `grace` | `true` (set by `enterGracePeriod`) | Payment failed; 7-day window to recover |
| `cancelled` | `true` (stays true until `gracePeriodEndsAt` passes) | Access runs to end of paid period |
| `cancelled_by_admin` | `false` (set immediately by admin) | Admin forced cancellation; MP preapproval also cancelled; `endDate` and `gracePeriodEndsAt` set to now |
| `scheduled` | `false` (not yet started) | Future subscription |
| `expired` | `false` (set by expiry jobs) | No access |

---

## 6. What happens when someone registers

File: `backend-simple-reserva/src/controllers/authController.js`

1. User created with role `restaurant_owner`.
2. `RestaurantOrganization` created:
   - `planId` = the chosen plan SKU from the registration form (defaults to `plan-basico`)
   - `trialEndsAt` = now + 14 days (for `plan-basico`) or null for plans with `freeTrialLength = 0`
3. First `Restaurant` created.
4. `Subscription` created with `status = "trial"`, `isActiveSubscription = true` and `planId` = chosen plan.
5. If the chosen plan has `freeTrialLength = 0` (Profesional, Premium), the registration response includes `requiresPayment: true` and the restaurant frontend redirects to `/billing?plan=<sku>` for immediate checkout.

---

## 7. What happens when someone buys a plan

File: `backend-simple-reserva/src/services/mercadopagoService.js` (`activateOrganizationSubscription`)

1. User goes to `/billing` in the restaurant frontend (`restaurant-front-simple-reserva/src/pages/BillingPage.tsx`).
2. Clicking a plan calls `POST /api/restaurant/:restaurantId/billing/checkout` which:
   - Creates a `CheckoutSession` in DB (with `pendingChangeFromSubscriptionId` if changing plans)
   - Calls `mercadopagoService.createSubscription()` to get a Mercado Pago preapproval URL
   - Returns the MP redirect URL to the frontend
3. User is redirected to Mercado Pago to authorize the recurring charge.
4. MP calls `POST /api/webhooks/mercadopago` with a `subscription_preapproval` event:
   - If MP status = `authorized`: runs `activateOrganizationSubscription()` in a transaction:
     - Cancels all existing `trial`, `active`, `scheduled` subscriptions for the org (sets `isActiveSubscription = false`)
     - Creates a new `Subscription` with `status = "active"`, `isActiveSubscription = true`, `startDate`, `currentPeriodEnd`
     - Updates `RestaurantOrganization.planId` = new plan's ID
     - Clears `trialEndsAt`
     - If `pendingChangeFromSubscriptionId` exists, cancels the old MP preapproval
   - If MP start date is >10 minutes in the future: creates a `scheduled` subscription
5. After redirect back, the frontend polls `GET /api/restaurant/:restaurantId/subscription` and calls `POST /api/restaurant/:restaurantId/billing/confirm` to complete the checkout session.

---

## 8. What happens when someone changes plans

File: `backend-simple-reserva/src/routes/billing.routes.js` (`POST /billing/change-plan`)

Two modes are supported via the `when` parameter:

### `when = "now"` (immediate upgrade/downgrade)
1. Creates a new `CheckoutSession` with `pendingChangeFromSubscriptionId` = current active sub's ID.
2. Opens a new MP preapproval checkout.
3. On activation webhook, the old MP preapproval is cancelled via MP API.
4. The new plan's limits and features take effect immediately.

### `when = "end_of_period"` (change at next renewal)
1. Cancels the current MP preapproval immediately.
2. Sets current subscription `status = "cancelled"` with `endDate = computePeriodEnd(...)` (access continues until then).
3. Creates a new `CheckoutSession` with billing `start_date` set to the period end.
4. On activation, the new subscription is created with `status = "scheduled"` until `startDate`.
5. The reconciliation job activates it when the time comes.

### Admin-forced plan change (no payment)
An admin can change the plan directly in the admin panel (`SubscriptionsPage`):
1. `PATCH /api/admin/subscriptions/:id` with `{ planId: "<newPlanId>" }`
2. Backend wraps the update in a transaction:
   - Updates `Subscription.planId`
   - Updates `RestaurantOrganization.planId` (so `resolvePlanConfig` resolves the new plan immediately)
3. Invalidates the in-memory plan config cache for that organization.
4. No Mercado Pago interaction — this is a manual override.

An admin can also directly toggle access by sending `{ isActiveSubscription: true/false }` to grant or revoke access immediately without going through any payment or expiry flow.

---

## 9. Billing cycles and period math

File: `backend-simple-reserva/src/lib/billingPeriod.js`

`computePeriodEnd(startDate, planConfig)` walks forward from `startDate` by the plan's `billingFrequency` + `billingFrequencyType` until the result is in the future:

```
billingFrequencyType = "months", billingFrequency = 1
  → adds 1 month at a time until > now
billingFrequencyType = "weeks", billingFrequency = 2
  → adds 14 days at a time
billingFrequencyType = "yearly", billingFrequency = 1
  → adds 12 months at a time
```

`currentPeriodEnd` on the `Subscription` row is persisted when a subscription is activated or renewed, so the admin can always see when the current billing period ends without recalculating.

`estimateNextPaymentDate(subscriptionRow, planConfig)` returns the same value for `status = "active"` subscriptions.

---

## 10. Grace period

When a Mercado Pago payment fails for a recurring subscription, the webhook sends a `payment_required` or `cancelled` event for the preapproval. The backend calls `enterGracePeriod(organizationId)`:

1. Sets `Subscription.status = "grace"`
2. Sets `Subscription.gracePeriodEndsAt = now + 7 days`
3. Keeps `isActiveSubscription = true` — access continues during the grace window

When a user manually cancels their subscription via `POST /billing/cancel`:

1. MP subscription is cancelled
2. Sets `Subscription.status = "cancelled"`, `endDate = periodEnd`, `currentPeriodEnd = periodEnd`
3. Sets `Subscription.gracePeriodEndsAt = periodEnd` (= `endDate`)
4. Keeps `isActiveSubscription = true` — access continues until period end

**In both cases**, the `gracePeriodExpiryJob` is the sole mechanism that sets `isActiveSubscription = false`. It runs daily and queries:

```js
// grace subs past their window
{ status: 'grace', gracePeriodEndsAt: { lt: now } } → { status: 'expired', isActiveSubscription: false }

// cancelled subs whose paid period has ended (gracePeriodEndsAt = endDate)
{ status: 'cancelled', isActiveSubscription: true, gracePeriodEndsAt: { lt: now } } → { status: 'expired', isActiveSubscription: false }
```

If a payment is retried and succeeds (MP sends another `payment` webhook with `approved`), the subscription is reactivated:
- `status = "active"`, `gracePeriodEndsAt = null`
- `isActiveSubscription` was already `true` during grace — no change needed

---

## 11. Feature gating — where and how it is enforced

### The access rule

```
hasAccess = await prisma.subscription.findFirst({
  where: { organizationId, isActiveSubscription: true }
})
```

`status`, `endDate`, `gracePeriodEndsAt`, and `trialEndsAt` are **never** used at query time to determine access. They are informational and drive UI display only.

### Backend (hard enforcement)

| What | File | Function |
|------|------|----------|
| Add restaurant location | `authController.js` (addRestaurant handler) | `planService.canAddLocation(ownerId)` |
| Add zone | `zone.routes.js` POST handler | `planService.canAddZone(restaurantId)` |
| Add table | `table.routes.js` POST handler | `planService.canAddTable(restaurantId)` |
| Invite team member | `team.routes.js` POST handler | `planService.canAddTeamMember(ownerId, restaurantId)` |
| Upload multiple menus | `menu.routes.js` POST handler | checks `plan.multipleMenu`; only `main` allowed if false |
| Send WhatsApp notifications | `notificationService.js` | checks `plan.whatsappFeatures` before sending |
| Create reservation (public) | `reservation.routes.js` | `subscriptionService.canCreateReservation(restaurantId)` |
| Send confirmations/reminders | called from reservation flow | `subscriptionService.canSendConfirmations/canSendReminders` |

`planService.resolvePlanConfig(ownerId)` is the single function that resolves the effective plan for an owner:
1. Looks up the latest active/trial/grace subscription and returns its `plan`
2. Falls back to `RestaurantOrganization.plan` (the `planId` field) if no subscription found
3. Results are cached in-memory for 60 seconds

### Restaurant frontend (soft enforcement / UX)

| Page | What it checks |
|------|----------------|
| `ZonesTablesPage.tsx` | `getSubscription()` → `planConfig.maxZonesPerRestaurant` + `maxTables`; disables add buttons at limit |
| `TablesStep.tsx` (onboarding) | Same limits during onboarding wizard |
| `SettingsProfilePage.tsx` | `getSubscription()` → `restaurantCount` + `maxRestaurants`; hides/replaces add button with upgrade prompt |
| `TeamPage.tsx` | Shows "Límite de plan" toast if API returns a plan-related error |
| `RestaurantLayout.tsx` | Shows trial/grace/expired banners and blocking modal when `!hasAccess` |
| `BillingPage.tsx` | Shows all plans, current usage bars, upgrade/downgrade CTAs |

### User frontend (passive signal)

`BookingPage.tsx` receives `reason: "subscription_expired"` from `GET /api/public/restaurants/:slug/availability`:
- Suppresses the "next available date" suggestion
- Hides the booking waitlist form

---

## 12. Where plan data is stored

```
Database (Postgres via Prisma)
├── Plan                         ← source of truth for plan config, prices, limits
├── RestaurantOrganization
│   ├── planId                   ← effective plan (kept in sync with active subscription)
│   ├── customPlanId             ← optional admin-assigned custom plan (for billing display)
│   └── trialEndsAt              ← informational trial end date (used by UI/emails only)
└── Subscription
    ├── isActiveSubscription     ← THE SINGLE ACCESS GATE (true/false)
    ├── planId                   ← plan for this subscription record
    ├── status                   ← informational: trial/active/grace/cancelled/expired/scheduled
    ├── endDate                  ← end of paid billing period; copied to gracePeriodEndsAt on cancel
    ├── currentPeriodEnd         ← end of current MP billing cycle (for UI display)
    └── gracePeriodEndsAt        ← when gracePeriodExpiryJob will set isActiveSubscription = false

In-memory (planService.js)
├── planCache       Map<productSKU, PlanConfig>     TTL: 60s
└── orgConfigCache  Map<"orgId:includeTrial", {ts, config}>  TTL: 60s
    → invalidated on: plan change via admin, org custom plan assignment
```

---

## 13. Admin operations

All via `backend-simple-reserva/src/routes/admin.routes.js` (requires `super_admin` role):

| Operation | Endpoint | Effect |
|-----------|----------|--------|
| List subscriptions | `GET /api/admin/subscriptions` | Paginated; includes `plan`, `organization`, all date fields |
| Edit subscription | `PATCH /api/admin/subscriptions/:id` | Updates `status`, `endDate`, `planId`, and/or `isActiveSubscription`; if `planId` changes: cascades to `RestaurantOrganization.planId` in a transaction + invalidates cache; if `isActiveSubscription = false`: cancels MP preapproval, sets `status = 'cancelled_by_admin'`, sets `endDate` and `gracePeriodEndsAt` to now, and invalidates cache |
| List plans | `GET /api/admin/plans` | All plans sorted by display order |
| Create plan | `POST /api/admin/plans` | Creates a new `Plan` row; clears plan cache |
| Edit plan | `PATCH /api/admin/plans/:id` | Updates plan config; clears plan cache |
| Delete plan | `DELETE /api/admin/plans/:id` | Only non-default plans; clears plan cache |
| Assign custom plan | `POST /api/admin/organizations/:orgId/assign-plan` | Sets `customPlanId` on the org; makes that plan available in billing UI |
| Get custom plan | `GET /api/admin/organizations/:orgId/custom-plan` | Returns the org's custom plan if set |

---

## 14. Cron jobs

All jobs are in `backend-simple-reserva/src/jobs/`:

| Job | Schedule (env var) | What it does |
|-----|--------------------|--------------|
| `trialReminderJob.js` | `TRIAL_REMINDER_CRON` | Emails owners with ≤7 days and ≤2 days left in trial |
| `trialExpiryJob.js` | `TRIAL_EXPIRY_CRON` | Sets `isActiveSubscription = false, status = 'expired'` when `trialEndsAt` has passed |
| `gracePeriodExpiryJob.js` | `GRACE_PERIOD_EXPIRY_CRON` | Sets `isActiveSubscription = false, status = 'expired'` for grace subs past `gracePeriodEndsAt`, AND for cancelled subs whose `gracePeriodEndsAt` (= endDate) has passed |
| `reconciliationJob.js` | `RECONCILIATION_CRON` | Activates `scheduled` subs whose `startDate` has passed; cleans up stale checkout sessions; detects MP↔DB drift |
| `reminderJob.js` | — | Sends reservation reminders; checks `canSendReminders` (same as `hasActiveAccess`) |

---

## 15. Key files per repo

### `backend-simple-reserva`

| File | Purpose |
|------|---------|
| `prisma/schema.prisma` | `Plan`, `Subscription`, `RestaurantOrganization`, `CheckoutSession`, `WebhookEvent` models |
| `prisma/seed.js` | Seeds the 3 default plans |
| `src/services/planService.js` | Plan resolution, feature checks, limit checks, in-memory cache |
| `src/services/subscriptionService.js` | `hasActiveAccess`, `getActiveSubscription`, `canCreateReservation` |
| `src/services/mercadopagoService.js` | Checkout creation, preapproval activation, grace period, MP API calls |
| `src/services/paymentReceiptService.js` | Creates receipts from MP payment webhooks |
| `src/lib/billingPeriod.js` | `computePeriodEnd`, `estimateNextPaymentDate` |
| `src/lib/planDisplayOrder.js` | Canonical sort order for plan cards |
| `src/routes/billing.routes.js` | `GET subscription`, `POST checkout`, `POST confirm`, `POST change-plan`, `POST reactivate`, `POST cancel` |
| `src/routes/admin.routes.js` | Admin CRUD for plans, subscriptions, org custom plan assignment |
| `src/routes/webhooks.routes.js` | Mercado Pago webhook handler (preapproval + payment events) |
| `src/controllers/authController.js` | Registration: creates org + trial subscription |
| `src/jobs/` | All cron jobs listed above |

### `admin-front-simple-reserva`

| File | Purpose |
|------|---------|
| `src/pages/SubscriptionsPage.tsx` | List + edit subscriptions; plan dropdown, billing cycle columns |
| `src/pages/PlansPage.tsx` | CRUD for plans; shows subscription counts per plan |
| `src/pages/RestaurantsPage.tsx` | Restaurant detail; assign custom plan to org |
| `src/api/subscriptions.ts` | `listSubscriptions`, `updateSubscription` |
| `src/api/plans.ts` | `listPlans`, `createPlan`, `updatePlan`, `deletePlan`, `Plan` interface |
| `src/api/restaurants.ts` | `assignCustomPlan`, `getOrganizationCustomPlan` |

### `restaurant-front-simple-reserva`

| File | Purpose |
|------|---------|
| `src/pages/BillingPage.tsx` | Full billing UI: plan comparison, checkout, change plan, cancel, payment history |
| `src/components/layout/RestaurantLayout.tsx` | Trial/grace banners, `hasAccess` blocking modal, subscription status line in nav |
| `src/pages/ZonesTablesPage.tsx` | Zone and table limit enforcement via `getSubscription` |
| `src/components/onboarding/TablesStep.tsx` | Same limits during onboarding |
| `src/pages/settings/SettingsProfilePage.tsx` | `maxRestaurants` limit, upgrade prompt |
| `src/pages/TeamPage.tsx` | Shows plan limit error from API on team invite |
| `src/api/restaurant.ts` | `getSubscription`, `createBillingCheckout`, `changeBillingPlan`, `reactivateBillingSubscription`, `cancelScheduledSubscription` |

### `user-front-simple-reserva`

| File | Purpose |
|------|---------|
| `src/api/plans.ts` | `PublicPlan` type, `DEFAULT_PLANS` fallback, `getPublicPlans()` |
| `src/components/landing/Pricing.tsx` | Public pricing section on landing page |
| `src/components/landing/planCardFeatures.tsx` | Plan card feature list renderer |
| `src/pages/BillingPage.tsx` — N/A | No billing UI in user frontend |
| `src/pages/BookingPage.tsx` | Hides waitlist + next-available when `reason = "subscription_expired"` |
| `src/pages/SocialPricingCardsPage.tsx` | Static pricing cards at `/social/planes` for social media screenshots |
