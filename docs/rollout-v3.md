# Rollout — Slot Engine v3

## Resumen
Hard cutover: migración de datos en bloque + deploy simultáneo de backend y ambos frontends. Downtime estimado: 3-5 minutos.

## Prerequisitos
- [ ] Tests pasando en staging: `node --test src/services/**/*.test.js`
- [ ] Snapshot manual de cupos por restaurante tomado (comparación post-deploy)
- [ ] Backup de BD tomado justo antes del deploy

## Garantía de preservación de datos

Esta migración **no elimina ni modifica** datos de negocio existentes:

| Dato | ¿Se preserva? | Notas |
|------|---------------|-------|
| Reservas (`Reservation`) | ✅ Sí | Sin cambios de esquema |
| Horarios (`Schedule`) | ✅ Sí | Sin cambios |
| Mesas y zonas | ✅ Sí | Sin cambios |
| Reglas de duración (`DurationRule`) | ✅ Sí | Sin cambios |
| Ventanas custom (`ReservationWindow`) | ✅ Sí | Sin cambios; el UI ya no las borra al desactivar custom |
| Cierres temporales (`BlockedSlot`) | ✅ Sí | Sin cambios |
| Config del restaurante | ✅ Sí | `slotIntervalMinutes` se preserva; legacy se alinea a `defaultSlotDurationMinutes` antes del cutover |
| `slotGenerationMode` | ⚠️ Eliminado | Era metadato de motor, no configuración de negocio |
| Holds (`ReservationHold`) | ✅ Nuevo | Tabla vacía al inicio; solo purga registros `expired/released/consumed` > 7 días |
| Pacing (`PacingRule`) | ✅ Nuevo | Tabla vacía al inicio; opcional |

---

## Paso 1 — Aplicar migración SQL

Conectar a la BD de producción y ejecutar:

```bash
psql $DATABASE_URL < prisma/migrations/20260520000000_slot_engine_v3/migration.sql
```

La migración es idempotente y data-preserving:
1. Copia `defaultSlotDurationMinutes → slotIntervalMinutes` para restaurantes en modo legacy
2. Elimina columna `slotGenerationMode`
3. Agrega `holdTtlSeconds`, `holdsEnabled` a `Restaurant`
4. Crea tablas `PacingRule` y `ReservationHold`

**Verificar:**
```sql
SELECT COUNT(*) FROM "Restaurant" WHERE "slotIntervalMinutes" IS NULL; -- debe ser 0
SELECT COUNT(*) FROM "Restaurant" WHERE "holdsEnabled" IS NULL;        -- debe ser 0
\d "PacingRule"
\d "ReservationHold"
```

---

## Paso 2 — Deploy backend

```bash
# En el servidor de backend:
git pull origin main
npm install --omit=dev
# Reiniciar servidor (PM2 / systemd / container según entorno)
pm2 restart simple-reserva-backend
```

**Verificar:**
- `GET /api/public/restaurants/:slug` devuelve `holdsEnabled` y `holdTtlSeconds`
- `GET /api/public/restaurants/:slug/availability?date=YYYY-MM-DD&partySize=2` devuelve slots
- `POST /api/restaurant/:id/availability/preview` responde 200 con `engineVersion: 3`

---

## Paso 3 — Deploy frontends

```bash
# Portal restaurante
cd restaurant-front-simple-reserva
npm run build
# Deploy dist/ a hosting (Netlify / S3 / Vercel)

# Portal comensal
cd user-front-simple-reserva
npm run build
# Deploy dist/ a hosting
```

---

## Paso 4 — Verificación post-deploy

### Smoke test manual (por restaurante migrado)
1. Abrir portal comensal: `/book/:slug`
2. Seleccionar fecha de mañana → verificar que aparecen cupos
3. Completar reserva → verificar confirmación
4. En portal restaurante → `/settings/availability` → verificar que carga sin errores
5. `/settings/availability` → preview → verificar cupos simulados

### Verificación automatizable
```bash
# Compara cupos pre/post por restaurante (requiere snapshot pre-deploy)
node scripts/verify-slots-post-deploy.js
```

### Check de holds
```sql
SELECT status, COUNT(*) FROM "ReservationHold"
GROUP BY status
ORDER BY status;
-- Esperado tras deploy limpio: sin rows, o solo 'active' si hay reservas en curso
```

---

## Rollback

Si se detecta un problema crítico dentro de los primeros 15 minutos:

1. Revertir frontend a versión anterior (deploy anterior)
2. Revertir backend a versión anterior
3. **No revertir la migración de BD** — `slotGenerationMode` fue eliminado. Para volver al motor v2 se necesitaría un script de reversión separado.

> El mejor rollback es haber verificado exhaustivamente en staging primero.

---

## Notas
- Los restaurantes con `slotIntervalMinutes` correctamente seteado mantendrán exactamente el mismo grid de cupos (la data migration preservó el comportamiento legacy)
- `holdTtlSeconds = 300` y `holdsEnabled = true` por defecto en todos los restaurantes
- El cron job `reservationHoldCleanup` empieza a correr automáticamente al iniciar el backend
