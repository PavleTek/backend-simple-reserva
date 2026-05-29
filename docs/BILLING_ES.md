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

En **Admin → Planes → Ofrecer a organizaciones**:

- `selfServicePlanChanges` — si el restaurante puede cambiar de plan solo
- `selfServiceBillingStrategyChanges` — si puede cambiar débito automático / pago manual

## Métodos de cobro

### Débito automático (`automatic_recurring`)

- API MP: Preapproval / Suscripciones
- Cobro recurrente; reintentos MP; mora → `grace` 7 días

### Pago mensual manual (`manual_monthly`)

- API MP: Checkout Pro (preferencias + link)
- Job `checkoutProRenewalJob` envía link antes de `currentPeriodEnd`
- Cambio de plan al fin de periodo: **no** se aplica `planId` hasta pago aprobado (`planChangeSchedulerJob` solo genera link)

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

## Variables de entorno

- `BILLING_STRATEGIES_ENABLED=automatic_recurring,manual_monthly`
- `PLAN_CHANGE_SCHEDULER_ENABLED` / `PLAN_CHANGE_SCHEDULER_CRON`
- `CHECKOUT_PRO_RENEWAL_CRON` / `CHECKOUT_PRO_RENEWAL_DAYS_BEFORE`
- `MP_WEBHOOK_SECRET` o `MP_WEBHOOK_SECRET_*`

## Migración segura (orden)

1. Hotfix webhook cancelled/expired
2. Scheduler manual sin aplicar plan sin pago
3. Contrato API `pendingChange` / `capabilities`
4. UX restaurante (copy es-CL, confirmación método de cobro)
5. Admin: flags en ofertas
6. `billingStateService` como único dispatcher de eventos

Ver también [BILLING_ARCHITECTURE.md](./BILLING_ARCHITECTURE.md) (referencia técnica en inglés).
