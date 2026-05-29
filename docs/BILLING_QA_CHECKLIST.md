# Checklist QA — Facturación SimpleReserva

Checklist manual para validar billing en **dev/staging** antes de producción. Complementa `npm run test:billing` (reglas puras, sin MP ni DB real).

**Leyenda:** `[L]` legacy · `[N]` usuario nuevo · `[ ]` pendiente · `[x]` OK · `[!]` falla

---

## 0. Preparación

| # | Tarea | Notas |
|---|--------|--------|
| 0.1 | Cuenta dueño (`restaurant_owner`) en org de prueba | |
| 0.2 | MP Chile sandbox / test users configurados | |
| 0.3 | Migración `20260530150000_custom_plan_offer_self_service` aplicada | |
| 0.4 | Backend y front restaurant en misma rama (`dev`) desplegados | |
| 0.5 | Correr `npm run test:billing` en backend (71 tests) | Automático |

### Datos de prueba sugeridos

| Persona | Cómo armarla | Identificador en API |
|---------|----------------|----------------------|
| **Legacy A** | Org con `customPlanId` **sin** fila `CustomPlanOffer` (o antes del backfill) | `planSource: legacy_assigned` |
| **Legacy B** | Sub antigua: solo `paymentProvider` legacy (`mercadopago_preapproval` / `mp_checkout_pro`) sin `billingStrategy` claro | Revisar `GET /subscription` |
| **Legacy C** | Cambio programado vía MP (`status=scheduled` en otra fila) | `scheduledChangeSource: mp_scheduled` |
| **Nuevo D** | Org recién creada post-migración, solo planes públicos | `planSource: catalog_default` |
| **Nuevo E** | `CustomPlanOffer` desde Admin (flags self-service ON) | `offeredPlans` + `planSource: offer` |
| **Enterprise F** | `CustomPlanOffer` con `selfServicePlanChanges: false` y/o `selfServiceBillingStrategyChanges: false` | `capabilities` en overview |

```bash
# Backfill legacy (staging, una vez)
node scripts/backfill-custom-plan-offers.js
node scripts/backfill-custom-plan-offers.js --apply
```

---

## 1. UI transversal (todos los estados)

| # | Caso | Esperado | L/N |
|---|------|----------|-----|
| 1.1 | Pestaña Plan: **un solo** banner de cambio programado (fecha `26 jun 2026`, no ISO cruda) | Sin duplicar en fila “Tu plan actual” | N/L |
| 1.2 | Botón “Cancelar cambio” en banner → `POST /billing/cancel-scheduled` | 200 + mensaje; desaparece banner | N/L |
| 1.3 | Pestaña Método de cobro: **una** línea principal (Débito automático / Pago mensual manual / Sin definir aún) | Sin doble “Se definirá…” | N/L |
| 1.4 | `GET /billing/overview` vs `GET /subscription`: `billingEmail` coherente donde aplique | | L |

---

## 2. Trial — activación inicial

| # | Caso | Pasos | Esperado | L/N |
|---|------|--------|----------|-----|
| 2.1 | Activar plan público + **débito automático** | Plan → Elegir plan → Activar → MP preapproval → volver | `status: active`, strategy automático | N |
| 2.2 | Activar plan público + **pago manual** | Igual con Checkout Pro | `manual_monthly`, sin preapproval activo | N |
| 2.3 | Activar **plan custom** (oferta) | Org con `CustomPlanOffer` | Plan visible en lista; checkout OK | E |
| 2.4 | Activar custom **legacy** `customPlanId` | Org Legacy A sin offer | Plan en `allPlans`; checkout OK | L |
| 2.5 | Plan no permitido | SKU sin offer ni público | 403 en checkout | N |
| 2.6 | **No** debe existir `change-plan` en trial | Preview o cambiar plan activo | Redirige a activación / checkout | N |
| 2.7 | Método de cobro en trial: elegir preferencia | Método de cobro → elegir; **no** debe llamar `payment-method/update` | Copy “se aplicará al activar”; al activar usa elección | N |

---

## 3. Activo — cambio de plan (default ↔ custom)

**Precondición:** `status: active`, acceso OK.

| # | Plan origen → destino | Cuándo | Método | Esperado | L/N |
|---|---------------------|--------|--------|----------|-----|
| 3.1 | Básico → Profesional | Ahora | Manual | Checkout MP; cobro mes completo; plan cambia al pagar | N |
| 3.2 | Básico → Profesional | Ahora | Automático | Preapproval/checkout; plan al autorizar/pagar | N |
| 3.3 | Básico → Premium | Fin de periodo | **Manual** | `scheduled: true` en DB; **sin** MP ahora; banner único; `pendingChange.source: db` | N |
| 3.4 | Básico → Premium | Fin de periodo | Automático | Checkout MP programado (`scheduled` MP o checkout EOP) | N |
| 3.5 | Premium → Básico (bajada) | Fin de periodo | Manual | Programado DB; sin cobro hasta fecha | N |
| 3.6 | Premium → Básico | Ahora | Cualquiera | Checkout; preview muestra cobro inmediato | N |
| 3.7 | Default → **Custom** (oferta) | Ahora / EOP | Manual EOP | Misma lógica 3.3 si manual | E |
| 3.8 | **Custom** → Default | Ahora | Automático | Checkout según preview | E/L |
| 3.9 | Mismo plan | — | — | Error “Ya tienes este plan” | N |
| 3.10 | Cancelar cambio programado (3.3) | Cancelar en banner | `cancel-scheduled` 200 `kind: db_plan_change` | N |
| 3.11 | Enterprise: cambio bloqueado | Org F | Botones deshabilitados / mensaje soporte; API 403 `plan_changes_managed` | E |

### Job manual EOP (staging, opcional acelerar fecha)

| # | Caso | Esperado |
|---|------|----------|
| 3.12 | Al llegar `scheduledChangeAt`, job genera **link** Checkout Pro | `planId` **no** cambia hasta pago aprobado (webhook) |
| 3.13 | Pago aprobado del link | Plan nuevo activo; campos programados limpios |

---

## 4. Activo — método de cobro (subs ↔ checkout)

| # | Transición | Esperado | L/N |
|---|------------|----------|-----|
| 4.1 | Débito automático → Pago manual | Toast éxito; **sin** redirect MP; preapproval cancelado en MP; strategy manual | N/L |
| 4.2 | Pago manual → Débito automático | Modal correo MP → redirect; tras OK, strategy automático | N |
| 4.3 | Mismo método → Continuar | Botón deshabilitado / noop | N |
| 4.4 | Enterprise: cambio método bloqueado | Org F; API 403 | E |
| 4.5 | Legacy B: inferencia strategy desde `paymentProvider` legacy | Card y picker muestran método correcto | L |

---

## 5. Grace — cobro fallido

| # | Caso | Esperado | L/N |
|---|------|----------|-----|
| 5.1 | UI banner grace + RecoveryFlow | No permite change-plan ni payment-method | N/L |
| 5.2 | Tras pagar recovery | Vuelve `active`; puede cambiar plan/método | N |

---

## 6. Cancelado con acceso (fin de periodo pagado)

| # | Caso | Método previo | Cuándo | Esperado | L/N |
|---|------|---------------|--------|----------|-----|
| 6.1 | Reactivar mismo plan | Manual | Fin de periodo | **Sin** checkout; JSON `reactivated: true` | N |
| 6.2 | Reactivar mismo plan | Manual | Ahora | Checkout MP | N |
| 6.3 | Reactivar mismo plan | Automático | Fin de periodo | Checkout MP programado al `endDate` | N |
| 6.4 | Reactivar + **cambiar plan** (p. ej. a custom) | Cualquiera | Ahora | Checkout con SKU nuevo; `orgCanUsePlan` | E |
| 6.5 | **No** change-plan directo | Intentar cambiar plan sin reactivar | Bloqueado; copy reactivar | N |
| 6.6 | Banner cancel_at_end + Reactivar | Clic Reactivar | Abre flujo reactivate | N |

---

## 7. Expirado / sin acceso

| # | Caso | Esperado | L/N |
|---|------|----------|-----|
| 7.1 | UI “Elige un plan para reactivar” | Solo checkout / activar | N |
| 7.2 | Checkout con manual o automático | Acceso restaurado tras pago | N |
| 7.3 | Método de cobro | Solo orientación; update API bloqueado | N |
| 7.4 | Legacy expirado que tenía customPlanId | Plan custom sigue visible si aplica | L |

---

## 8. Programaciones y cancelaciones MP

| # | Caso | Esperado | L/N |
|---|------|----------|-----|
| 8.1 | Cambio EOP **automático** (sub `scheduled` en MP) | Banner renovación/cambio; cancelar → `kind: mp_scheduled` | N |
| 8.2 | Renovación mismo plan (cancelled + scheduled mismo SKU) | Banner `renewal_scheduled`; “Cancelar renovación” | L |
| 8.3 | Cancelar suscripción al fin del periodo (no confundir con cambio plan) | `cancel_at_end` banner; acceso hasta fecha | N/L |

---

## 9. Admin y datos legacy

| # | Caso | Esperado | L/N |
|---|------|----------|-----|
| 9.1 | Admin: ofrecer plan custom + flags OFF | Restaurant no puede cambiar plan/método | E |
| 9.2 | Admin: `assign-plan` (legacy API) | Crea `CustomPlanOffer`; limpia `customPlanId` | L→N |
| 9.3 | Post-backfill Legacy A | `CustomPlanOffer` existe; flags default true | L |
| 9.4 | Plan custom solo en `offeredPlans` / merge lista | Sin duplicados en UI | N |

---

## 10. Mercado Pago y regresiones conocidas

| # | Caso | Esperado | L/N |
|---|------|----------|-----|
| 10.1 | Webhook preapproval **cancelled/expired** | **No** entra gracia automática | L |
| 10.2 | Return URL checkout success / failure | Estado coherente en app | N |
| 10.3 | Correo MP distinto al de la cuenta | Error claro en modal | N |
| 10.4 | Doble clic checkout mismo plan | Reutiliza sesión pendiente o expira y crea nueva | N |
| 10.5 | `cancel-scheduled` con solo cambio DB (bug histórico) | Ya no 400 “No hay suscripción programada” | N/L |
| 10.6 | Manual + **Subir plan ahora** | Debe abrir MP (Checkout Pro por defecto), **no** programar EOP sin redirect | N |

---

## 11. Matriz rápida — método de cobro × estado

Marca cada celda al probar (ideal: 1 org o reset entre casos).

| Estado | subs→manual (activo) | manual→subs (activo) | En trial (solo preferencia) | En expirado | En cancelado | En grace |
|--------|----------------------|----------------------|----------------------------|-------------|--------------|----------|
| **Nuevo** | 4.1 | 4.2 | 2.7 | 7.3 | 6.5 | 5.1 |
| **Legacy** | 4.1 + 4.5 | 4.2 + 4.5 | 2.7 | 7.4 | 6.x | 5.1 |

---

## 12. Matriz rápida — cambio de plan × estrategia (solo activo)

| Cuándo | Manual | Automático |
|--------|--------|------------|
| **Ahora** | 3.1 (checkout) | 3.2 (checkout/preapproval) |
| **Fin de periodo** | 3.3 (DB + banner + cancel) | 3.4 (checkout MP) |

---

## 13. Smoke post-deploy (15 min)

1. `[N]` Trial → activar Básico manual → activo.
2. `[N]` Cambio EOP a Profesional manual → banner → cancelar → banner desaparece.
3. `[N]` Cambio EOP a Premium manual → banner → **no** duplicado.
4. `[N]` manual → automático → MP → vuelve activo automático.
5. `[N]` automático → manual → sin MP, toast OK.
6. `[L]` Org con customPlanId: plan visible + checkout OK (si aplica).

---

## Referencias

- Reglas: `src/lib/billingFlowMatrix.js`
- Tests: `npm run test:billing`
- Ops: `docs/BILLING_ES.md`
