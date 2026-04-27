# Reservation Flow — System Documentation

This document covers the end-to-end online booking flow for SimpleReserva: from the moment a user opens the booking page to the creation of a confirmed reservation, including all DB models, backend services, API endpoints, frontend components, and the key design decisions.

---

## Table of contents

1. [High-level overview](#1-high-level-overview)
2. [DB structure for reservations](#2-db-structure-for-reservations)
3. [Effective timezone resolution](#3-effective-timezone-resolution)
4. [Schedule windows & slot generation](#4-schedule-windows--slot-generation)
5. [Availability computation — how it works](#5-availability-computation--how-it-works)
6. [Public API endpoints](#6-public-api-endpoints)
7. [Table assignment algorithm](#7-table-assignment-algorithm)
8. [Subscription gating](#8-subscription-gating)
9. [Notification fan-out](#9-notification-fan-out)
10. [Frontend booking flow](#10-frontend-booking-flow)
11. [Bug: "slots shown that aren't really available" — root cause & fix](#11-bug-slots-shown-that-arent-really-available--root-cause--fix)
12. [Timezone policy (frontend)](#12-timezone-policy-frontend)
13. [Known follow-ups](#13-known-follow-ups)
14. [File-by-file reference](#14-file-by-file-reference)

---

## 1. High-level overview

```
User opens /book/:slug
    │
    ▼
GET /api/public/restaurants/:slug          ← restaurant info, zones, active days
    │
    ▼
BookingPage.tsx
  ├── DatePartyPicker  (date, party size)
  ├── ZoneSelector     (optional zone preference)
  └── TimeSlotGrid     (available times)
         │
         ▼  (one fetch per date change)
GET /api/public/restaurants/:slug/day-snapshot?date=YYYY-MM-DD
         │
         ▼  (synchronous, no network)
computeSlots(snapshot, partySize, zoneId, clientNow)   ← src/lib/availability.ts
         │
         ▼
User selects time → ContactForm
         │
         ▼
POST /api/reservations
  ├── Subscription check
  ├── Schedule / blocked-slot validation
  ├── Table assignment (Serializable transaction)
  └── reservation created → secureToken
         │
         ▼
Redirect to /reservation/:secureToken
  + WhatsApp / email confirmations sent async
```

---

## 2. DB structure for reservations

All models live in `prisma/schema.prisma`.

### `Restaurant`

Key fields relevant to reservations:

| Field | Type | Purpose |
|-------|------|---------|
| `slug` | String (unique) | Public URL identifier |
| `defaultSlotDurationMinutes` | Int (default 60) | Length of each time slot |
| `bufferMinutesBetweenReservations` | Int (default 0) | Dead-time between consecutive bookings on the same table |
| `advanceBookingLimitDays` | Int (default 30) | How far ahead a user can book |
| `minimumNoticeMinutes` | Int (default 60) | Earliest a user may book (relative to now) |
| `scheduleMode` | String | `"continuous"` or `"service_periods"` |
| `timezone` | String? | IANA timezone override; if null, derived from owner's country |
| `isActive` | Boolean | Soft-delete flag |

Index: `@@index([organizationId])`, `@@index([isActive])`

### `Zone`

One restaurant → many zones (e.g. "Salón", "Terraza"). Zones group tables logically.

| Field | Purpose |
|-------|---------|
| `restaurantId` | Owner |
| `sortOrder` | Display order (used in table-assignment priority) |
| `isActive` | Soft-delete |

### `RestaurantTable`

Each table belongs to one zone.

| Field | Purpose |
|-------|---------|
| `zoneId` | Parent zone |
| `minCapacity` | Minimum group size this table can seat |
| `maxCapacity` | Maximum group size |
| `sortOrder` | Within-zone ordering (used in auto-assignment) |
| `isActive` | Soft-delete |

**Capacity filtering**: when computing availability for `partySize = N`, only tables where `minCapacity ≤ N ≤ maxCapacity` are considered.

Index: `@@index([zoneId])`

### `Schedule`

One row per active day of week per restaurant.

| Field | Purpose |
|-------|---------|
| `dayOfWeek` | 0 = Sunday … 6 = Saturday |
| `openTime` / `closeTime` | `"HH:mm"` — used when `scheduleMode = "continuous"` |
| `breakfastStartTime` / `breakfastEndTime` | Used when `scheduleMode = "service_periods"` |
| `lunchStartTime` / `lunchEndTime` | — |
| `dinnerStartTime` / `dinnerEndTime` | — |
| `isActive` | Whether this day is active |

Unique constraint: `@@unique([restaurantId, dayOfWeek])` — only one schedule row per restaurant/day.

### `BlockedSlot`

An explicit range during which no new reservations are allowed (e.g. private event, maintenance).

| Field | Purpose |
|-------|---------|
| `startDatetime` / `endDatetime` | UTC timestamps of the blocked range |
| `reason` | Optional text shown to staff |

Index: `@@index([restaurantId, startDatetime, endDatetime])`

### `DurationRule`

Overrides `defaultSlotDurationMinutes` for specific party-size ranges.

| Field | Purpose |
|-------|---------|
| `minPartySize` / `maxPartySize` | Inclusive range |
| `durationMinutes` | Duration for groups in this range |

Unique: `@@unique([restaurantId, minPartySize])`

### `Reservation`

| Field | Purpose |
|-------|---------|
| `tableId` | Assigned table (nullable — auto-assigned at create time) |
| `partySize` | Number of guests |
| `dateTime` | UTC start time |
| `durationMinutes` | Slot length at booking time |
| `status` | `"confirmed"` `"cancelled"` `"completed"` `"no_show"` |
| `source` | `"web"` (public booking) · `"manual"` (admin panel) · `"phone"` |
| `secureToken` | Unique cuid for sharing/modifying the reservation (no auth required) |

Availability queries only look at `status = 'confirmed'` reservations.

Index: `@@index([restaurantId, dateTime, status])` — primary index for availability queries.

### `BookingWaitlistEntry`

Created when a user submits the waitlist form (no slots available).

| Field | Purpose |
|-------|---------|
| `partySize` / `preferredDate` | What they wanted |
| `customerName` / `customerPhone` / `customerEmail` | Contact info |
| `status` | `"pending"` by default |

---

## 3. Effective timezone resolution

**File**: `backend-simple-reserva/src/utils/timezone.js`

```
getEffectiveTimezone(restaurant, ownerCountry)
  ↓
  if restaurant.timezone is set → use it
  else → COUNTRY_TIMEZONES[ownerCountry]
          CL → America/Santiago
          AR → America/Argentina/Buenos_Aires
          UY → America/Montevideo
```

This timezone is used everywhere: generating slot times, comparing reservations, computing `isToday`, enforcing `minimumNoticeMinutes`.

Key functions:

| Function | Purpose |
|----------|---------|
| `getEffectiveTimezone(restaurant, country)` | Resolves the IANA timezone string |
| `parseInTimezone(date, time, timezone)` | `"YYYY-MM-DD"` + `"HH:mm"` → UTC `Date` (uses Luxon) |
| `nowInTimezone(timezone)` | Returns a Luxon `DateTime` for the current moment in the given TZ |
| `formatInTimezone(date, timezone, format)` | Formats a UTC date in a given timezone |

---

## 4. Schedule windows & slot generation

**File**: `backend-simple-reserva/src/utils/scheduleUtils.js`

### `getScheduleWindows(schedule, scheduleMode)`

Returns an array of `[startMin, endMin]` pairs (minutes from midnight) representing valid service windows for the day.

- **continuous**: a single window `[openTime, closeTime]`.
- **service_periods**: up to three windows — breakfast, lunch, dinner. Missing periods are skipped.

### `generateTimeSlots(schedule, slotDuration, scheduleMode)`

Iterates each window in steps of `slotDuration`. A slot is emitted only if `startMin + slotDuration ≤ endMin` (i.e. the slot fits entirely within the window). Returns `[{ time: "HH:mm", startMin }]`.

### `isSlotInSchedule(schedule, timeMin, slotDuration, scheduleMode)`

Returns `true` if a slot starting at `timeMin` (minutes) and lasting `slotDuration` fits within any window. Used at booking-create time to validate the requested time.

### `resolveDuration(restaurant, partySize, durationRules)`

Picks the duration for a given party size:
1. Find the first `DurationRule` where `minPartySize ≤ partySize ≤ maxPartySize` (sorted ascending by `minPartySize`).
2. If none match, fall back to `restaurant.defaultSlotDurationMinutes`.

---

## 5. Availability computation — how it works

**File**: `backend-simple-reserva/src/services/availabilityService.js`

### Step 1 — Load the day snapshot (`loadDaySnapshot`)

Fetches all data for a calendar day in a single parallel query burst:

- The `Schedule` for the requested day-of-week
- All active `RestaurantTable` rows (with zone info)
- All active `Zone` rows
- All `DurationRule` rows
- All `BlockedSlot` rows that overlap the day
- All `confirmed` `Reservation` rows in the day window (start of day − 12 h, to catch long reservations from the previous evening)

Returns a plain object containing these lists plus `serverNowUtc` and `isToday`.

### Step 2 — Compute availability (`computeAvailability`)

Pure, synchronous — no DB calls. Given a snapshot, `partySize`, and optional `zoneId`:

1. **No schedule** → `{ slots: [], reason: 'no_schedule' }`
2. **Candidate tables** = tables where `minCapacity ≤ partySize ≤ maxCapacity` and (if `zoneId` set) `zoneId` matches. If empty → `{ slots: [], reason: 'no_tables' }`
3. **Duration** = `resolveDuration(defaults, durationRules, partySize)`
4. **Slot defs** = `generateTimeSlots(schedule, duration, scheduleMode)`. If empty → `{ slots: [], reason: 'no_slots' }`
5. For each slot:
   - **Today cutoff**: if `isToday` and `slotStart < now + minimumNoticeMinutes` → skip
   - **Blocked**: if any `BlockedSlot` overlaps `[slotStart, slotEnd)` → skip
   - **Open tables**: count how many candidate tables have no `confirmed` reservation overlapping `[slotStart, slotEnd + bufferMinutes)`
   - If `openTables > 0` → emit `{ time, available: true, availableTables: openTables }`
6. If nothing emitted → `{ slots: [], reason: 'no_availability' }`

### The key insight

Because `computeAvailability` is pure and cheap, the frontend can call it synchronously for **any** `(partySize, zoneId)` combination after loading the snapshot once per date — eliminating the race condition that caused stale slots to appear.

---

## 6. Public API endpoints

All public endpoints are mounted at `/api/public/restaurants/` and `/api/public/reservations/` (same router, no auth required).

**File**: `backend-simple-reserva/src/routes/reservation.routes.js`

---

### `GET /api/public/restaurants/:slug`

Returns restaurant metadata for the booking page.

**Key response fields**:

| Field | Source |
|-------|--------|
| `zones[].tables[]` | Active zones with capacity ranges |
| `activeDays` | Distinct `dayOfWeek` values from active schedules |
| `bookingEnabled` | `hasActiveAccess(organizationId)` |
| `effectiveTimezone` | From `getEffectiveTimezone(...)` |
| `advanceBookingLimitDays` | From restaurant record (default 30) |
| `minimumNoticeMinutes` | From restaurant record (default 60) |

---

### `GET /api/public/restaurants/:slug/day-snapshot?date=YYYY-MM-DD`  *(new)*

Returns everything needed to compute available slots for **any** `(partySize, zoneId)` on the specified day — without additional API calls. The client calls `computeSlots()` (see §10) on this data.

**Example response**:

```json
{
  "date": "2026-04-17",
  "timezone": "America/Santiago",
  "subscriptionActive": true,
  "isToday": true,
  "serverNowUtc": "2026-04-17T15:42:00.000Z",
  "schedule": {
    "dayOfWeek": 5,
    "scheduleMode": "continuous",
    "openTime": "12:00",
    "closeTime": "22:00",
    ...
  },
  "defaults": {
    "slotDurationMinutes": 60,
    "bufferMinutesBetweenReservations": 0,
    "minimumNoticeMinutes": 60,
    "advanceBookingLimitDays": 30
  },
  "durationRules": [
    { "minPartySize": 5, "maxPartySize": 12, "durationMinutes": 90 }
  ],
  "tables": [
    { "id": "t1", "zoneId": "z1", "minCapacity": 1, "maxCapacity": 2, "sortOrder": 0, "zoneSortOrder": 0 }
  ],
  "zones": [{ "id": "z1", "name": "Salón", "sortOrder": 0 }],
  "blockedSlots": [
    { "startUtc": "2026-04-17T18:00:00.000Z", "endUtc": "2026-04-17T20:00:00.000Z" }
  ],
  "reservations": [
    { "tableId": "t1", "startUtc": "2026-04-17T16:00:00.000Z", "durationMinutes": 60 }
  ]
}
```

> **Privacy**: `reservations` contains only `tableId`, `startUtc`, `durationMinutes` — no customer name, phone, or email.

When `subscriptionActive = false`, all data fields are null/empty and the client shows the "subscription expired" state.

---

### `GET /api/public/restaurants/:slug/availability?date=YYYY-MM-DD&partySize=N[&zoneId=Z]`

Legacy endpoint — kept for backward compatibility. Internally calls `loadDaySnapshot` + `computeAvailability` for the given `(partySize, zoneId)`. Use the day-snapshot endpoint for new integrations.

---

### `GET /api/public/restaurants/:slug/next-available?date=YYYY-MM-DD&partySize=N[&zoneId=Z]`

Searches forward from `date` (exclusive) up to `advanceBookingLimitDays`, returning the first date with at least one available slot for the given `partySize`/`zoneId`.

Uses `loadDaySnapshot` + `computeAvailability` in a sequential loop (one DB query per day candidate).

---

### `POST /api/public/restaurants/:slug/waitlist`

Creates a `BookingWaitlistEntry`. Notifies the restaurant via WhatsApp/email asynchronously.

Required body: `partySize`, `customerName`, `customerPhone`.
Optional: `preferredDate`, `customerEmail`, `notes`.

---

### `POST /api/reservations`

Creates a reservation. Runs inside a **Serializable** transaction to prevent double-booking.

**Validation sequence** (before transaction):
1. Required fields present
2. Restaurant exists and is active
3. `canCreateReservation(restaurant.id)` — subscription check
4. `dateTime` in the future, within `advanceBookingLimitDays`
5. `dateTime` ≥ `now + minimumNoticeMinutes`

**Inside the transaction**:
1. Schedule exists for that day of week
2. `isSlotInSchedule` — time falls within the schedule window
3. No overlapping `BlockedSlot`
4. Tables exist for `partySize`
5. `pickAutoTable(...)` — selects the best available table (see §7)
6. `reservation.create(...)` with `isolationLevel: 'Serializable'`

**Post-commit (async, non-blocking)**:
- `incrementDataVersion(restaurantId)` — bumps a version counter used by the admin panel's polling
- `incrementReservationAnalytics(...)` — daily analytics counter
- `sendReservationConfirmation` (WhatsApp) + `sendReservationConfirmationEmail` (if email provided)

Response: `201` with the full reservation record including `secureToken`.

---

### `GET /api/reservations/token/:secureToken`

Returns the reservation by its `secureToken`. Includes `restaurant.effectiveTimezone` for correct local time display.

---

### `PATCH /api/reservations/token/:secureToken`

Modifies date/time/partySize of an existing `confirmed` reservation.

Runs the same validation as create (schedule check, blocked-slot check, table availability — excluding the reservation itself from conflict detection). Picks a new table via `pickAutoTable`. Sends a modification alert to the customer.

---

### `PATCH /api/reservations/token/:secureToken/cancel`

Sets `status = 'cancelled'`. Sends a cancellation notification to the restaurant (email) and to the customer (WhatsApp).

---

## 7. Table assignment algorithm

**File**: `backend-simple-reserva/src/lib/tableAssignment.js`

### `pickAutoTable(tables, partySize, dayReservations, dateTime, slotEnd, bufferMs, preferredZoneId)`

1. Filters tables to those **free** at `[dateTime, slotEnd + bufferMs)` using `hasConflictOnTable`.
2. Sorts free tables with `compareTablesForAutoAssign`:
   - **Zone preference first**: if `preferredZoneId` is set, tables in that zone rank ahead of others.
   - **Least slack**: `maxCapacity − partySize` ascending — avoids wasting large tables on small groups.
   - **Zone sort order**: ties broken by `zone.sortOrder` ascending.
   - **Table sort order**: then `table.sortOrder` ascending.
   - **maxCapacity** ascending, then `id` lexicographic (deterministic tie-breaker).
3. Returns the first element (best match), or `null` if no free table exists.

### `hasConflictOnTable(tableId, dayReservations, dateTime, slotEnd, bufferMs)`

Returns `true` if any reservation on this table overlaps the window `[dateTime, slotEnd + bufferMs)`:

```
conflict when: dateTime < rEnd + bufferMs  AND  slotEnd > r.dateTime
```

---

## 8. Subscription gating

**File**: `backend-simple-reserva/src/services/subscriptionService.js`

`hasActiveAccess(organizationId)` — returns `true` if the organization has at least one `Subscription` row with `isActiveSubscription = true`. This is the **sole source of truth** for access; the `status` field on `Subscription` is informational only.

Gating points in the reservation flow:

| Where | What happens if inactive |
|-------|--------------------------|
| `GET /:slug` | `bookingEnabled = false` — frontend shows "not accepting reservations" |
| `GET /:slug/day-snapshot` | `subscriptionActive: false` — frontend shows same disabled state |
| `GET /:slug/availability` | `{ slots: [], reason: 'subscription_expired' }` |
| `GET /:slug/next-available` | `{ nextDate: null, reason: 'subscription_expired' }` |
| `POST /api/reservations` | `canCreateReservation` throws `ValidationError` |

---

## 9. Notification fan-out

**File**: `backend-simple-reserva/src/services/notificationService.js`

All notifications are fire-and-forget — called after the transaction commits, failures are caught and logged but never surface to the user.

| Function | Trigger | Channel |
|----------|---------|---------|
| `sendReservationConfirmation` | Reservation created | WhatsApp to customer |
| `sendReservationConfirmationEmail` | Reservation created (if email provided) | HTML email to customer (branded template in `src/templates/reservationConfirmationEmail.js`, date/time in restaurant IANA timezone; palette mirrors [user-front-simple-reserva/docs/STYLING.md](../user-front-simple-reserva/docs/STYLING.md)) |
| `sendModificationAlertToCustomer` | Reservation modified or cancelled | WhatsApp to customer |
| `sendCancellationNotification` | Reservation cancelled | Email to restaurant owner |
| `notifyRestaurantWaitlistEntry` | Waitlist entry created | WhatsApp/email to restaurant |

WhatsApp uses the Meta Business Cloud API (credentials in `Configuration` DB table or env vars).

---

## 10. Frontend booking flow

**Entry point**: `user-front-simple-reserva/src/pages/BookingPage.tsx`

### Component tree

```
BookingPage
  ├── Navbar (minimal)
  ├── Restaurant header card
  │     └── expandable details (address, phone, menus)
  └── Booking card (AnimatePresence)
        ├── view = 'selection'
        │     ├── DatePartyPicker    ← date tabs + calendar + party-size buttons
        │     ├── TimeSlotGrid       ← derived available slots; scarcity badge
        │     ├── ZoneSelector       ← optional zone preference
        │     └── BookingWaitlistForm (shown when no slots for that date)
        └── view = 'contact'
              └── ContactForm        ← name, phone, email, notes + submit
```

### Data flow

```
restaurant loaded (once on mount)
    ↓
date changes (user selects today/tomorrow/other)
    ↓  AbortController cancels any in-flight request
GET /day-snapshot?date=...    → setSnapshot(snap)
    ↓
useMemo: computeSlots(snapshot, partySize, selectedZoneId, clientNow)
    ↓
TimeSlotGrid renders available slots (instant, no network)
    ↓
partySize / zone changes → useMemo re-runs synchronously
    ↓
setInterval(60s) → setClientNow(new Date()) → useMemo re-runs, drops past slots
```

### Key state

| State | Type | Set by |
|-------|------|--------|
| `date` | `string` (YYYY-MM-DD) | DatePartyPicker, initial value from `getTodayInTZ` |
| `partySize` | `number` | DatePartyPicker |
| `selectedZoneId` | `string\|null` | ZoneSelector |
| `snapshot` | `DaySnapshot\|null` | Snapshot fetch effect |
| `snapshotLoading` | `boolean` | Snapshot fetch effect |
| `clientNow` | `Date` | 60 s interval |
| `slots` / `availabilityReason` | derived | `useMemo` from snapshot |
| `selectedTime` | `string` | TimeSlotGrid |
| `view` | `'selection'\|'contact'` | Continue / Back buttons |

### `computeSlots` — frontend mirror of backend `computeAvailability`

**File**: `user-front-simple-reserva/src/lib/availability.ts`

Implements the exact same rules as the backend (see §5), using native `Intl.DateTimeFormat` for timezone-aware date parsing (two-pass approach for DST accuracy). Both implementations must stay in sync.

---

## 11. Bug: "slots shown that aren't really available" — root cause & fix

### Root cause

The old `BookingPage.tsx` called `getAvailability(slug, date, partySize, zoneId)` inside a `useEffect` keyed on `[slug, date, partySize, selectedZoneId]`. It had **no AbortController** and **no cleanup function**.

When a user clicked party sizes quickly (e.g. 2 → 3 → 4 → 2), four parallel requests fired. Whichever resolved **last** "won" and set the slot list — regardless of which party size was currently selected. A slow earlier request for partySize=4 could arrive after the user had already switched back to partySize=2, displaying slots that are only available for 4 people.

Secondary issue: `minimumNoticeMinutes` was evaluated at request time. If a user left the page open, slots that had become too recent would still appear (until the next date change triggered a new request).

### Fix

1. **Fetch once per date** — the new `GET /day-snapshot` endpoint returns all tables, reservations, and blocked slots without any party-size/zone filtering.
2. **Derive on the client** — `computeSlots(snapshot, partySize, zoneId, clientNow)` runs synchronously (no network, ~1 ms) in a `useMemo`. Party-size and zone changes now update the slot grid **instantly** with zero race risk.
3. **AbortController** — the snapshot fetch is cancelled on unmount or when the date changes, preventing any stale network responses from being processed.
4. **Live `clientNow`** — a `setInterval(60_000)` bumps `clientNow`, which causes the `useMemo` to re-run and drop the earliest slot once it enters the minimum-notice window.

### Server is still the final authority

`computeSlots` is best-effort — two users may both see the same slot as available. The `POST /api/reservations` transaction runs at `Serializable` isolation level and calls `pickAutoTable` inside the transaction. If all tables are taken by the time the user submits, the server returns `"No hay mesas disponibles en este horario"` and the user can pick another slot.

---

## 12. Timezone policy (frontend)

### The rule

> **All time logic that touches a restaurant's date, time, schedule, day-of-week, or displayed reservation MUST go through `lib/tz.ts` and receive the restaurant's `effectiveTimezone`.**

Browser timezone is NEVER used for restaurant-scoped logic. A customer in Madrid booking a Santiago restaurant, or a staff member in Mexico City managing a Buenos Aires panel, must always see and operate in the restaurant's local time — not their own.

### Why it matters

`Date.prototype.getDay()` and friends return values in the **server's** (or browser's) local timezone. When a server runs in UTC and the restaurant is in `America/Santiago` (UTC-4), a Saturday midnight booking (`2026-04-18T04:00:00Z`) gets `dateTime.getDay() = 6` on UTC — but a server in US-Eastern time sees `getDay() = 5` (Friday), allowing the booking to pass schedule validation on a closed day.

### How it is enforced

Both frontend apps (`user-front-simple-reserva` and `restaurant-front-simple-reserva`) have:

1. **`src/lib/tz.ts`** — the canonical module. All booking-flow code imports time functions exclusively from here.
2. **`@deprecated` JSDoc** on `formatDateLocal`, `formatTime`, `formatDateDisplay`, `formatDateTime` in `src/lib/utils.ts` — these use browser timezone and must not be used in reservation contexts.
3. **ESLint `no-restricted-syntax` guardrail** in `eslint.config.js` — emits a `warn` when `.getDay()`, `.getHours()`, `.getMinutes()`, `.getDate()`, `.getMonth()`, or `.getFullYear()` are called inside `pages/` or `components/booking/`. Use `// eslint-disable-next-line` with an explanatory comment for the (rare) legitimate exceptions.

### `lib/tz.ts` API surface (identical on both frontends)

| Function | Returns | Notes |
|----------|---------|-------|
| `nowInTZ(tz)` | Luxon `DateTime` | Current moment in restaurant TZ |
| `todayInTZ(tz)` | `"YYYY-MM-DD"` | Restaurant's today |
| `tomorrowInTZ(tz)` | `"YYYY-MM-DD"` | Restaurant's tomorrow |
| `addDaysInTZ(dateStr, n, tz)` | `"YYYY-MM-DD"` | Calendar-day arithmetic in restaurant TZ; handles DST |
| `dayOfWeekInTZ(dateOrStr, tz)` | `0..6` | 0=Sunday. Mirrors backend `getDayOfWeekInTimezone()` |
| `parseInTZ(dateStr, timeStr, tz)` | `Date` (UTC) | Restaurant local "date + HH:mm" → UTC moment. Mirrors backend `parseInTimezone()` |
| `weekRangeInTZ(tz, anchor?)` | `{from, to}` | Monday–Sunday week containing anchor (or today) in restaurant TZ |
| `formatDateStrDisplay(dateStr)` | `"dd/mm/yyyy"` | Pure string reformat of `YYYY-MM-DD`; no TZ conversion |
| `dateStrToPickerDate(dateStr)` | `Date` | Noon-UTC trick for `react-datepicker`'s `selected` prop |
| `restaurantTodayForPicker(tz)` | `Date` | Restaurant today as a picker-compatible Date for `minDate`/`highlightDates` |
| `formatDateLocalInTZ(d, tz)` | `"YYYY-MM-DD"` | Re-exported from `utils.ts` |
| `formatTimeInTZ(d, tz)` | `"HH:mm"` | Re-exported from `utils.ts` |
| `formatDateDisplayInTZ(d, tz)` | `"dd/mm/yyyy"` | Re-exported from `utils.ts` |
| `formatDateTimeInTZ(d, tz)` | `"dd/mm/yyyy HH:mm"` | Re-exported from `utils.ts` |

### Do / Don't table

| Don't | Do |
|-------|----|
| `new Date().getDay()` | `dayOfWeekInTZ(todayInTZ(tz), tz)` |
| `new Date().toISOString().split('T')[0]` | `todayInTZ(restaurantTZ)` |
| `dateTime.getHours() * 60 + dateTime.getMinutes()` | derive from the `time` string directly: `const [h, m] = time.split(':').map(Number)` |
| `formatDateLocal(new Date(r.dateTime))` | `formatDateLocalInTZ(new Date(r.dateTime), restaurantTZ)` |
| `formatDateDisplay(new Date(dateStr + 'T12:00:00'))` | `formatDateStrDisplay(dateStr)` |
| `new Date(); d.setDate(d.getDate() + 1)` | `tomorrowInTZ(restaurantTZ)` |
| Week range via `getDay()` + `setDate()` | `weekRangeInTZ(restaurantTZ)` |

### react-datepicker caveat

`react-datepicker` always renders in the **browser's** local timezone — this cannot be overridden. The workaround:

- Feed it `dateStrToPickerDate(restaurantDateStr)` for `selected` (noon-UTC → browser sees correct calendar day in any UTC±12 timezone).
- Feed it `restaurantTodayForPicker(restaurantTZ)` for `minDate` and `highlightDates` (same trick, derived from the restaurant's today).
- When the user picks a date, read it back via `d.getUTCFullYear/Month/Date()` (not `getFullYear/Month/Date()`) since we fed it a UTC noon value.

### Mirrors

This policy aligns all three layers:

| Layer | Module | Key function |
|-------|--------|-------------|
| Backend | `src/utils/timezone.js` | `getDayOfWeekInTimezone`, `parseInTimezone`, `nowInTimezone` |
| User-front | `src/lib/tz.ts` | `dayOfWeekInTZ`, `parseInTZ`, `nowInTZ` |
| Admin-front | `src/lib/tz.ts` | (same API as user-front) |

Any logic change to availability computation must be applied to all three.

---

## 13. Known follow-ups

- **Modify-reservation race**: `PATCH /token/:secureToken` on the confirmation page (`ConfirmationPage.tsx`) has the same "no AbortController" pattern as the old availability fetch. Same fix applies.
- **Cross-midnight reservation edge case**: the snapshot's reservation window extends 12 h before midnight of the selected day, which covers most practical cases (restaurants rarely have 12+ hour seatings). If a future requirement calls for overnight bookings, increase this buffer.
- **BookingEvent analytics polling**: `BookingEvent` rows are inserted client-side. If the backend is unreachable (network partition), those events are silently dropped. Consider a retry queue.

---

## 14. File-by-file reference

| File | What it does | Key exports / routes |
|------|-------------|---------------------|
| `backend-simple-reserva/prisma/schema.prisma` | Full DB schema | All models |
| `src/services/availabilityService.js` | Day-snapshot loading + availability computation | `loadDaySnapshot`, `computeAvailability`, `getAvailabilitySlotsForRestaurant`, `findNextAvailableDateForSlug` |
| `src/services/availabilityService.test.js` | Unit tests for `computeAvailability` | 11 test cases (a–j) |
| `src/routes/reservation.routes.js` | All public reservation & restaurant routes | `GET /:slug`, `GET /:slug/day-snapshot`, `GET /:slug/availability`, `GET /:slug/next-available`, `POST /`, `PATCH /token/:t`, `GET /token/:t`, `POST /:slug/waitlist` |
| `src/utils/scheduleUtils.js` | Schedule window & slot generation | `getScheduleWindows`, `generateTimeSlots`, `isSlotInSchedule`, `resolveDuration` |
| `src/lib/tableAssignment.js` | Best-fit table selection | `pickAutoTable`, `hasConflictOnTable`, `compareTablesForAutoAssign` |
| `src/utils/timezone.js` | Timezone resolution and parsing | `getEffectiveTimezone`, `parseInTimezone`, `nowInTimezone` |
| `src/services/subscriptionService.js` | Subscription & feature gating | `hasActiveAccess`, `canCreateReservation`, `canSendConfirmations` |
| `src/services/notificationService.js` | WhatsApp / email notifications | `sendReservationConfirmation`, `sendReservationConfirmationEmail`, `sendModificationAlertToCustomer`, `sendCancellationNotification`, `notifyRestaurantWaitlistEntry` |
| `src/index.js` | Express app entry, route mounting | `app.use('/api/public/restaurants', reservationRouter)` |
| `user-front-simple-reserva/src/pages/BookingPage.tsx` | Main booking UI orchestrator | All state, effects, handlers |
| `user-front-simple-reserva/src/lib/availability.ts` | Frontend mirror of `computeAvailability` | `computeSlots(snapshot, partySize, zoneId, clientNow)` |
| `user-front-simple-reserva/src/api/restaurants.ts` | Backend API client | `getRestaurant`, `getDaySnapshot`, `getAvailability`, `getNextAvailable`, types |
| `user-front-simple-reserva/src/api/reservations.ts` | Reservation API client | `createReservation`, `getReservationByToken`, `updateReservation`, `cancelReservation` |
| `user-front-simple-reserva/src/components/booking/DatePartyPicker.tsx` | Date + party-size + zone UI | Props: `date`, `partySize`, `onDateChange`, `onPartySizeChange` |
| `user-front-simple-reserva/src/components/booking/TimeSlotGrid.tsx` | Slot grid + scarcity badge | Props: `slots`, `selectedTime`, `loading`, `onSelect`, `onNext` |
| `user-front-simple-reserva/src/components/booking/ZoneSelector.tsx` | Zone preference selector | Props: `zones`, `partySize`, `selectedZoneId`, `onZoneChange` |
| `user-front-simple-reserva/src/components/booking/ContactForm.tsx` | Guest contact form | Props: `onSubmit`, `summary`, `submitting` |
| `user-front-simple-reserva/src/components/booking/ConfirmationCard.tsx` | Post-booking confirmation | Props: `reservation` |
| `user-front-simple-reserva/src/components/booking/BookingWaitlistForm.tsx` | Waitlist signup (no slots available) | Props: `slug`, `partySize`, `preferredDate` |
