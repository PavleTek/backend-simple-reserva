# Facturación SimpleReserva (es-CL)

Documentación operativa y de producto para el modelo de billing actual (Mercado Pago: débito automático + pago mensual manual).

## Modelo de dominio

Tres capas **ortogonales**:

| Capa | Campo | Valores visibles al usuario |
|------|--------|----------------------------|
| **Plan / entitlement** | `Subscription.planId`, `isActiveSubscription` | Básico, Profesional, Premium, planes ofrecidos |
| **Método de cobro** | `billingStrategy` | Débito automático · Pago mensual manual |
| **PSP** | `paymentProvider` | Procesado por Mercado Pago (interno) |

### Regla de acceso

```
Acceso a features = ∃ Subscription con isActiveSubscription = true
```

El campo `status` es **informativo** (UI, emails, jobs). No debe usarse como única fuente de acceso.

### Origen del plan (`planSource` en API)

- `catalog_default` — plan público (`isDefault`)
- `offer` — `CustomPlanOffer` para la organización
- `legacy_assigned` — `RestaurantOrganization.customPlanId` (deprecado; usar ofertas)
- `active_entitlement` — plan de la suscripción activa

### Ofertas personalizadas

En **Admin → Planes → Ofrecer a organizaciones** (`CustomPlanOffer`):

- `selfServicePlanChanges` — si el restaurante puede cambiar de plan solo
- `selfServiceBillingStrategyChanges` — si puede cambiar débito automático / pago manual

**Migración legacy:** `RestaurantOrganization.customPlanId` queda deprecado. Usar ofertas en admin o `POST /admin/organizations/:id/assign-plan` (ahora crea `CustomPlanOffer`). Para orgs existentes:

```bash
node scripts/backfill-custom-plan-offers.js        # dry-run
node scripts/backfill-custom-plan-offers.js --apply
```

### Alertas en facturación (UI)

`GET /billing/overview` expone `alerts[]` con `type` y fechas ISO. El portal compone el texto en español chileno (`billingAlertCopy.ts`); no duplicar banners en la pestaña Plan.

## Métodos de cobro

### Débito automático (`automatic_recurring`)

- API MP: Preapproval / Suscripciones
- Cobro recurrente; reintentos MP; mora → `grace` 7 días

### Pago mensual manual (`manual_monthly`)

- API MP: Checkout Pro (preferencias + link)
- Job `billingRenewalReminderJob`: recordatorios **7, 4 y 1** día antes de `currentPeriodEnd` (solo si no renovó)
- Job `manualPeriodOverdueJob`: si vence el periodo sin pago → `grace` 7 días + correo + link recovery
- Job `lastChanceLinkJob`: ~24 h antes de `gracePeriodEndsAt`
- Idempotencia: tabla `BillingEmailLog` (`subscriptionId`, `kind`, `periodKey`)
- Cambio de plan al fin de periodo: **no** se aplica `planId` hasta pago aprobado (`planChangeSchedulerJob` solo genera link)

### Correos al owner (kinds)

| kind | Cuándo |
|------|--------|
| `renewal_7d` / `renewal_4d` / `renewal_1d` | Manual activo, antes del vencimiento |
| `period_overdue` | Manual vencido, entrada a gracia |
| `grace_entered` | Fallo de cobro (débito automático o webhook) |
| `grace_last_chance_1d` | Fin de gracia próximo |
| `checkout_payment_rejected` | Pago MP rechazado en checkout |

### Admin: preview y alertas

- **Organización → Correos de facturación** o **Suscripciones → panel → Correos de facturación**
- `GET /admin/organizations/:id/billing-emails/preview?kind=&dryRun=1`
- `POST /admin/organizations/:id/billing-emails/send`
- **Alertas facturación** (`/billing-alerts`): pagos rechazados, mora, fallos de link (`BillingOpsAlert`)

## Referidos: ventana de días gratis

Los créditos del referidor otorgan una **ventana de acceso gratis** (`Subscription.referralFreeUntil` + `currentPeriodEnd`), agnóstica al método de cobro:

| Método | Durante la ventana | Primer cobro real |
|--------|-------------------|-------------------|
| **Pago manual** | Acceso activo sin cobro en MP | Link de renovación (job `billingRenewalReminderJob`) antes de `referralFreeUntil` |
| **Débito automático** | Sub `active`; preapproval autorizado con `start_date = referralFreeUntil` | Primer cargo al vencer la ventana |

Reglas de producto:

- En ventana activa se puede **cambiar a cualquier plan**; se conservan `referralFreeUntil` y `currentPeriodEnd`.
- **Cambiar método de cobro no modifica** la ventana (manual→automático difiere solo el `start_date` del preapproval).
- El tiempo ya otorgado **no se revoca** ante refund/chargeback; sí se procesa reversa del referido y alerta admin.
- Primer pago aprobado (CP o preapproval) limpia `referralFreeUntil` y avanza el periodo de facturación.

Implementación: `referralFreeWindowService.js`, `consumeCreditsForSubscription` en `referralService.js`.

## Cambios de plan

- **Sin prorrateo:** upgrade inmediato = mes completo del plan nuevo; ciclo reinicia al pagar.
- **Recomendado:** upgrade → ahora; downgrade → al próximo ciclo.
- Preview: `POST /billing/change-plan/preview` con `when`: `immediate` | `end_of_period`.
- `requiresCheckout` en preview refleja si hace falta pasar por MP (manual + fin de periodo solo programa en DB).

## Autogestión (`canSelfServeBilling`)

Permitido con acceso activo y `status` en `active` o `trial` (checkout). Bloqueado en:

- `grace` — usar recovery primero
- `cancelled` in-period — reactivar primero
- `cancelled_by_admin` — plan gestionado por soporte

## Webhooks Mercado Pago

- `payment_required` → periodo de gracia (`PAYMENT_FAILED`)
- `cancelled` / `expired` en preapproval → **no** entra en gracia; `MP_PREAPPROVAL_CANCELLED` vía `billingStateService`
- `payment` aprobado Checkout Pro → activación / renovación / recovery

## API restaurante (resumen)

| Método | Ruta | Uso |
|--------|------|-----|
| GET | `/subscription` | Estado + `pendingChange`, `capabilities`, `entitlement` |
| GET | `/billing/overview` | Resumen y alertas |
| POST | `/billing/change-plan/preview` | Preview |
| POST | `/billing/change-plan` | Ejecutar |
| POST | `/billing/payment-method/update` | Cambiar método de cobro |
| POST | `/billing/reactivate` | Cancelada con acceso vigente |
| POST | `/billing/cancel-scheduled` | Cancela cambio programado (DB en sub activa o MP `scheduled`) |

## Variables de entorno

- `BILLING_STRATEGIES_ENABLED=automatic_recurring,manual_monthly`
- `PLAN_CHANGE_SCHEDULER_ENABLED` / `PLAN_CHANGE_SCHEDULER_CRON`
- `CHECKOUT_PRO_RENEWAL_CRON` / `CHECKOUT_PRO_RENEWAL_REMINDER_DAYS` (legacy: `CHECKOUT_PRO_RENEWAL_DAYS_BEFORE`)
- `MANUAL_PERIOD_OVERDUE_CRON` / `LAST_CHANCE_HOURS_BEFORE_EXPIRY` / `BILLING_OPS_ALERTS_ENABLED`
- `MP_WEBHOOK_SECRET` o `MP_WEBHOOK_SECRET_*`

## Checklist QA manual

Lista completa (legacy, usuarios nuevos, todos los caminos): **[BILLING_QA_CHECKLIST.md](./BILLING_QA_CHECKLIST.md)**.

## Tests unitarios de flujos

Matriz de decisiones pura: `src/lib/billingFlowMatrix.js` (activación, cambio de plan, método de cobro, reactivación, cancelar programado).

```bash
node --test src/lib/billingFlowMatrix.test.js
```

Incluye ~45 casos nombrados + tests de `canSelfServeBilling`, `collectionMethodSwitch` y `cancel-scheduled`. No reemplazan E2E con Mercado Pago ni Prisma real.

## Migración segura (orden)

1. Hotfix webhook cancelled/expired
2. Scheduler manual sin aplicar plan sin pago
3. Contrato API `pendingChange` / `capabilities`
4. UX restaurante (copy es-CL, confirmación método de cobro)
5. Admin: flags en ofertas
6. Backfill `customPlanId` → `CustomPlanOffer` (`scripts/backfill-custom-plan-offers.js`)
7. `billingStateService` como único dispatcher de eventos

Ver también [BILLING_ARCHITECTURE.md](./BILLING_ARCHITECTURE.md) (referencia técnica en inglés).
