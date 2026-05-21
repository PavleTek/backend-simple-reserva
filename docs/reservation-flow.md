# Flujo de Reservas — Documentación del Sistema (v3)

Este documento cubre el flujo de reservas en línea de SimpleReserva: desde que el usuario abre la página de reserva hasta la confirmación, incluyendo modelos de BD, servicios de backend, endpoints de API, componentes de frontend y las decisiones de diseño clave.

**Motor activo:** Slot Engine v3 (clock-aligned, siempre activo). No hay modo legacy ni feature flags.

---

## Tabla de contenidos

1. [Resumen de la arquitectura v3](#1-resumen-de-la-arquitectura-v3)
2. [Los cuatro ejes ortogonales](#2-los-cuatro-ejes-ortogonales)
3. [Modelos de base de datos](#3-modelos-de-base-de-datos)
4. [Invariante: una reserva = una mesa](#4-invariante-una-reserva--una-mesa)
5. [Slot Engine v3 — módulos](#5-slot-engine-v3--módulos)
6. [loadDaySnapshot — fuente de verdad](#6-loaddaysnapshot--fuente-de-verdad)
7. [computeAvailability — flujo](#7-computeavailability--flujo)
8. [Sistema de Holds (bloqueo temporal)](#8-sistema-de-holds-bloqueo-temporal)
9. [Transacciones y prevención de carreras](#9-transacciones-y-prevención-de-carreras)
10. [PacingRule — límites por intervalo](#10-pacingrule--límites-por-intervalo)
11. [Endpoints públicos](#11-endpoints-públicos)
12. [Endpoints staff/restaurant](#12-endpoints-staffrestaurant)
13. [Frontend: portal comensal](#13-frontend-portal-comensal)
14. [Frontend: portal restaurante](#14-frontend-portal-restaurante)
15. [Restricciones explícitas (no soportado)](#15-restricciones-explícitas-no-soportado)
16. [Referencia de archivos](#16-referencia-de-archivos)

---

## 1. Resumen de la arquitectura v3

```
Usuario abre /book/:slug
    │
    ▼
GET /api/public/restaurants/:slug        ← info restaurante, zonas, holdsEnabled
    │
    ▼
BookingPage.tsx
  ├── DatePartyPicker
  ├── ZoneSelector
  └── TimeSlotGrid
         │
         ▼ (re-fetch por cada cambio de fecha / party size / zona)
GET /api/public/restaurants/:slug/availability?date=&partySize=&zoneId=
         │
         ▼
slotEngine.getAvailabilitySlotsForRestaurant()
         │
         └── loadDaySnapshot → computeAvailability → slots[]
    │
    ▼ (usuario selecciona hora → crea hold si holdsEnabled)
POST /api/public/restaurants/:slug/reservation-holds
         │
         └── ReservationHold (soft-lock temporal, TTL = holdTtlSeconds)
    │
    ▼ (usuario llena formulario y confirma)
POST /api/reservations
         │
         ├── si holdToken → consume hold → asigna tabla del hold
         └── si no → validateSlotForBooking + pickTable
                 │
                 └── Serializable TX + retry P2034
```

**Principio clave:** toda la lógica de disponibilidad vive en el backend (`slotEngine`). El frontend nunca calcula slots localmente.

---

## 2. Los cuatro ejes ortogonales

| Eje | Campo / Modelo | Descripción |
|-----|----------------|-------------|
| **Horario de operación** | `Schedule.openTime/closeTime` o períodos de servicio | Cuándo está abierto el restaurante |
| **Ventana de reserva** | `ReservationWindow` o horario operativo | Cuándo se pueden tomar reservas (subconjunto del horario) |
| **Intervalo de slots** | `Restaurant.slotIntervalMinutes` | Cada cuánto aparece un cupo (independiente de la duración) |
| **Duración de reserva** | `Restaurant.defaultSlotDurationMinutes` + `DurationRule` | Cuánto ocupa la mesa (puede variar por tamaño de grupo) |

La separación de estos cuatro ejes es la diferencia fundamental con el sistema legacy.

---

## 3. Modelos de base de datos

### Restaurant (campos relevantes)
- `slotIntervalMinutes` — intervalo del grid en minutos (ej. 30)
- `defaultSlotDurationMinutes` — duración base por reserva (ej. 60)
- `bufferMinutesBetweenReservations` — tiempo extra entre fin de reserva e inicio de la siguiente
- `minimumNoticeMinutes` — aviso mínimo para que el cupo aparezca hoy
- `advanceBookingLimitDays` — cuántos días hacia adelante puede reservar un comensal
- `holdsEnabled` — activa/desactiva el sistema de holds
- `holdTtlSeconds` — tiempo de vida del hold (default 300 seg)

### DurationRule
Reglas de duración por rango de tamaño de grupo. Si `partySize` cae en un rango, se usa `durationMinutes` en vez del default.

### ReservationWindow
Ventanas personalizadas de toma de reservas por día de la semana. Si no hay ventanas customizadas, se usa el horario operativo completo.

### PacingRule
Límites opcionales de cobertura/reservas por intervalo de slot. Campos: `dayOfWeek` (null = todos los días), `maxCoversPerSlot`, `maxReservationsPerSlot`.

### ReservationHold
Bloqueo temporal de una mesa durante el checkout. Campos clave:
- `holdToken` — UUID único para referenciar el hold
- `expiresAt` — `createdAt + holdTtlSeconds`
- `status` — `active | consumed | released | expired`
- `tableId` — mesa asignada al crear el hold

---

## 4. Invariante: una reserva = una mesa

**`Reservation.tableId` es NOT NULL.** No hay combinaciones automáticas de mesas ni table joins. El invariante se aplica en tres capas:

1. **`capacity.pickTable()`** — selecciona la mesa individual de menor tamaño que cumple (`minCapacity ≤ partySize ≤ maxCapacity`). Si no existe ninguna mesa individual para el grupo, retorna `null`.
2. **`validate.validateSlotForBooking()`** — si `pickTable` retorna `null`, devuelve `reason: 'party_size_exceeds_largest_table'`.
3. **API endpoints** — si la validación falla, el endpoint responde HTTP 409 con el reason correspondiente.

Cuando ninguna mesa individual puede acomodar al grupo, el portal comensal muestra la opción de lista de espera (waitlist).

---

## 5. Slot Engine v3 — módulos

Todos los módulos viven en `backend-simple-reserva/src/services/slotEngine/`.

| Módulo | Responsabilidad |
|--------|----------------|
| `windows.js` | Calcula ventanas de operación y de reserva (en minutos del día) |
| `grid.js` | Genera el grid clock-aligned con `alignToGrid`, `generateGrid`, `isOnGrid` |
| `duration.js` | Resuelve la duración de reserva para un tamaño de grupo vía `resolveDuration` |
| `capacity.js` | Verifica mesas libres, parsea reservas y holds activos, aplica buffer y pacing |
| `policies.js` | Aplica políticas: aviso mínimo, límite avanzado, slots bloqueados |
| `validate.js` | Validación completa de un slot para crear/modificar reserva |
| `index.js` | API pública: `loadDaySnapshot`, `computeAvailability`, `validateSlotForBooking`, `previewSlots`, `getAvailabilitySlotsForRestaurant`, `findNextAvailableDateForSlug`, `resolveDuration` |

**Versión del motor:** `ENGINE_VERSION = 3` (exportada desde `index.js`).

---

## 6. loadDaySnapshot — fuente de verdad

`loadDaySnapshot(restaurantId, dateStr)` carga desde la BD todo lo necesario para calcular disponibilidad de un día:

```js
{
  engineVersion: 3,
  date: '2026-05-20',
  timezone: 'America/Santiago',
  subscriptionActive: true,
  isToday: false,
  serverNowUtc: '...',
  schedule: { scheduleMode, openTime, closeTime, ... },
  defaults: { slotIntervalMinutes, slotDurationMinutes, bufferMinutesBetweenReservations, ... },
  durationRules: [...],
  tables: [{ id, zoneId, minCapacity, maxCapacity, ... }],
  zones: [...],
  blockedSlots: [{ startUtc, endUtc }],
  reservations: [{ tableId, startUtc, durationMinutes }],
  activeHolds: [{ tableId, dateTime, durationMinutes, expiresAt }],
  pacingRules: [{ dayOfWeek, maxCoversPerSlot, maxReservationsPerSlot }],
  reservationWindows: [{ startTime, endTime }],
  holdsEnabled: true,
}
```

La ventana de lookback para reservas/holds es `max(defaultSlotDurationMinutes, maxDurationRule) * 2` minutos antes del inicio del día, para capturar reservas que empezaron el día anterior y siguen activas.

---

## 7. computeAvailability — flujo

```
computeAvailability(snapshot, partySize, zoneId?)
│
├── subscriptionActive? → no → reason: 'subscription_expired'
├── schedule? → no → reason: 'no_schedule'
├── isDateClosed(snapshot, date)? → yes → reason: 'date_closed'
│
├── applyPolicies(snapshot, partySize) → policies
│   ├── validateBookingPolicies → reason si fuera de rango
│   └── parsedBlockedSlots
│
├── resolveDuration(defaults, durationRules, partySize) → durationMinutes
├── getReservationWindows(snapshot) → windows[]
├── generateGrid(windows, slotIntervalMinutes) → gridSlots[]
│   └── isOnGrid → filtra sólo slots clock-aligned
│
├── getCandidateTables(tables, partySize, zoneId) → candidateTables[]
│   └── ninguna → reason: 'party_size_exceeds_largest_table'
│
├── parseReservations(reservations) → parsedReservations[]
├── parseHolds(activeHolds) → parsedHolds[]
│
└── por cada gridSlot:
    ├── minNotice / advanceBooking → filtra
    ├── blockedSlots overlap → filtra
    ├── checkPacing(slot, ...) → excede límite → filtra
    └── countFreeTables(slot, candidateTables, parsedReservations, parsedHolds, buffer)
        └── > 0 → slot disponible
```

---

## 8. Sistema de Holds (bloqueo temporal)

### Objetivo
Prevenir race conditions durante el checkout: cuando un comensal selecciona un horario, se bloquea una mesa específica temporalmente mientras llena el formulario.

### Flujo
1. Usuario selecciona hora → `POST /api/public/restaurants/:slug/reservation-holds`
   - Backend: `validateSlotForBooking` + `pickTable` → crea `ReservationHold`
   - Retorna: `{ holdToken, expiresAt, tableId, durationMinutes }`
2. `capacity.js` incluye holds activos (no expirados) como ocupados al calcular disponibilidad
3. Usuario confirma → `POST /api/reservations` con `holdToken`
   - Backend consume el hold (`status = consumed`), usa la mesa pre-asignada
4. Usuario abandona → `DELETE /api/public/reservation-holds/:holdToken`
   - También se libera via `fetch keepalive` en `beforeunload`
5. Cron job (`reservationHoldCleanup.js`, corre cada minuto): marca holds expirados, purga registros viejos

### Endpoint de creación
`POST /api/public/restaurants/:slug/reservation-holds`
```json
{ "date": "2026-05-20", "time": "20:00", "partySize": 2, "zoneId": "..." }
```
Respuesta: `{ holdToken, expiresAt, tableId, durationMinutes }`

---

## 9. Transacciones y prevención de carreras

Todos los endpoints críticos de creación/modificación de reservas usan:

```js
withSerializableRetry(prisma, async (tx) => { ... }, { maxRetries: 3 })
```

Esto aplica `Serializable` isolation level y reintenta automáticamente en errores `P2034` (conflicto de serialización en PostgreSQL). Aplica a:
- `POST /api/reservations` (creación pública)
- `PATCH /api/reservations/token/:token` (modificación del comensal)
- `POST /api/restaurant/:id/reservations` (creación manual staff)
- `PATCH /api/restaurant/:id/reservations/:id` (modificación manual staff)
- `POST /api/public/restaurants/:slug/reservation-holds` (creación de hold)

---

## 10. PacingRule — límites por intervalo

Permite limitar la cantidad de reservas o de personas por intervalo de slot, independientemente de las mesas disponibles. Útil para controlar la carga de cocina.

- `dayOfWeek: null` → aplica a todos los días
- `maxCoversPerSlot` → tope de personas totales en ese slot
- `maxReservationsPerSlot` → tope de reservas en ese slot

Si un slot supera cualquiera de estos límites, `checkPacing()` lo marca como no disponible.

---

## 11. Endpoints públicos

| Método | Path | Descripción |
|--------|------|-------------|
| GET | `/api/public/restaurants/:slug` | Info del restaurante + `holdsEnabled`, `holdTtlSeconds` |
| GET | `/api/public/restaurants/:slug/availability` | Slots disponibles (`?date=&partySize=&zoneId=`) |
| GET | `/api/public/restaurants/:slug/next-available` | Próxima fecha con disponibilidad |
| POST | `/api/reservations` | Crear reserva (acepta `holdToken` opcional) |
| PATCH | `/api/reservations/token/:token` | Modificar reserva como comensal |
| POST | `/api/public/restaurants/:slug/reservation-holds` | Crear hold |
| DELETE | `/api/public/reservation-holds/:holdToken` | Liberar hold |

---

## 12. Endpoints staff/restaurant

| Método | Path | Descripción |
|--------|------|-------------|
| GET | `/api/restaurant/:id/availability` | Disponibilidad (vista staff) |
| POST | `/api/restaurant/:id/availability/preview` | Preview con config tentativa (sin tocar BD) |
| GET | `/api/restaurant/:id/duration-rules` | Reglas de duración |
| PUT | `/api/restaurant/:id/duration-rules` | Actualizar reglas de duración |
| GET | `/api/restaurant/:id/pacing-rules` | Reglas de pacing |
| PUT | `/api/restaurant/:id/pacing-rules` | Actualizar reglas de pacing |
| GET | `/api/restaurant/:id/reservation-windows` | Ventanas de reserva |
| PUT | `/api/restaurant/:id/reservation-windows` | Actualizar ventanas |
| GET | `/api/restaurant/:id/holds` | Holds activos (vista staff) |

---

## 13. Frontend: portal comensal

### BookingPage.tsx
- Usa `getAvailability()` (server-side) en vez de `getDaySnapshot()` + `computeSlots()` (eliminado)
- Re-fetch automático al cambiar `date`, `partySize` o `zoneId`
- Flujo de hold:
  - Al seleccionar hora → `createReservationHold()` → muestra countdown en ContactForm
  - Al ir atrás → `releaseReservationHold()` (async)
  - En `beforeunload` → `releaseReservationHoldBeacon()` (fetch keepalive)
  - Al expirar el hold → vuelve a selección con mensaje de error

### Archivos eliminados
- `user-front-simple-reserva/src/lib/availability.ts` (cálculo client-side, reemplazado por API server-side)
- `user-front-simple-reserva/src/lib/availability.test.ts` (tests de paridad ya no necesarios)

---

## 14. Frontend: portal restaurante

### Nuevas páginas/componentes
- `/settings/availability` → `AvailabilityPage.tsx` — 6 secciones: horario, intervalo, duración, ventanas, pacing, políticas + preview integrada
- `AvailabilityPreview.tsx` — selector de día/party size + timeline visual de cupos, llama al endpoint de preview

### Archivos eliminados
- `restaurant-front-simple-reserva/src/components/ReservationSlotSimulator.tsx`
- `restaurant-front-simple-reserva/src/components/SlotEngineUpgradeBanner.tsx`
- `restaurant-front-simple-reserva/src/pages/SettingsPage.tsx` (página huérfana)
- `restaurant-front-simple-reserva/src/lib/reservationSlots.ts`

---

## 15. Restricciones explícitas (no soportado)

- **Sin combinaciones automáticas de mesas** — una reserva = una mesa física. Si ninguna mesa individual acomoda al grupo, se ofrece waitlist.
- **Sin shifts/turnos** — el motor no maneja conceptos de "turno almuerzo" o "turno cena" como entidades separadas. Las ventanas de reserva cubren ese caso de uso.
- **Sin modo legacy** — `slotGenerationMode` fue eliminado. Todos los restaurantes usan el motor clock-aligned v3.
- **Sin feature flags** — `ENABLE_CLOCK_ALIGNED_SLOTS`, `SHADOW_SLOT_ENGINE`, `ENABLE_RESERVATION_WINDOWS`, `ENABLE_SLOT_SIMULATOR` fueron removidos.

---

## 16. Referencia de archivos

### Backend
```
backend-simple-reserva/
├── prisma/
│   └── migrations/20260520000000_slot_engine_v3/migration.sql
├── src/
│   ├── services/slotEngine/
│   │   ├── index.js          # API pública del motor
│   │   ├── windows.js        # Ventanas de operación/reserva
│   │   ├── grid.js           # Grid clock-aligned
│   │   ├── duration.js       # Resolución de duración por grupo
│   │   ├── capacity.js       # Capacidad, holds, pacing
│   │   ├── policies.js       # Políticas: notice, advance, blocked
│   │   ├── validate.js       # Validación completa de slot
│   │   └── __tests__/slotEngine.test.js
│   ├── jobs/reservationHoldCleanup.js
│   └── routes/
│       ├── reservationHold.routes.js
│       ├── reservation.routes.js
│       └── restaurant.routes.js
```

### Frontend
```
restaurant-front-simple-reserva/src/
├── pages/settings/
│   └── AvailabilityPage.tsx
├── components/
│   ├── AvailabilityPreview.tsx
│   └── onboarding/ReservationRulesStep.tsx

user-front-simple-reserva/src/
└── pages/BookingPage.tsx     # consume getAvailability() + hold flow
```
