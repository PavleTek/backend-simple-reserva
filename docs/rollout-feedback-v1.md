# Rollout — Feedback post-visita v1

## Resumen

Motor `feedbackEngine` + job cron cada 10 min + encuesta pública en user-front + panel **Experiencia** en restaurant-front.

## Métricas (no usar "NPS")

- **Índice de satisfacción**: % notas 4–5 menos % notas 1–2 (escala 1–5 emojis).
- **Tasa de clic**: `clicked / sent` (CTA `/api/public/feedback/:token/click`).
- **Tasa de respuesta**: `completed / sent`.

## Defaults

| Parámetro | Valor |
|-----------|-------|
| `sendWindowMinutes` | 240 |
| `minDaysBetweenFeedbackRequests` | 14 |
| `sendDelayMinutes` | 75 |
| `FeedbackSurvey.enabled` | false |
| `FEEDBACK_TOKEN_TTL_DAYS` | 14 |

## Variables de entorno

```
FEEDBACK_CRON=*/10 * * * *
FEEDBACK_TOKEN_TTL_DAYS=14
FEEDBACK_ENABLED_GLOBAL=true
FEEDBACK_EMAIL_SUBJECT_VARIANT=a   # o b para piloto A/B
BACKEND_PUBLIC_URL=https://api...
FRONTEND_LANDING_PAGE_URL=https://...
```

## Subject lines piloto (manual A/B)

- **Variante a:** `¿Cómo estuvo tu visita a {nombre}?`
- **Variante b:** `{nombre} — cuéntanos en 30 segundos`

Monitorear `clicked/sent` y `completed/clicked` por variante.

## Deploy

1. `npx prisma migrate deploy`
2. Deploy backend (job activo si `FEEDBACK_ENABLED_GLOBAL` ≠ false)
3. Deploy user-front + restaurant-front
4. Pilot: `FeedbackSurvey.enabled=true` en 3–5 locales
5. Logs: `[FeedbackJob]`

## Benchmarking (fase 3, datos desde v1)

`FeedbackResponse` denormaliza `organizationId`, `cityKey`, `hourBucket`, `zoneId` para agregados internos vía `getBenchmarkAggregates()` — **no exponer en UI v1**.

Ejemplo futuro: *"Tus viernes 20:00–21:00 están 22% por debajo de restaurantes similares en Santiago."*

## Fase 3 (documentado)

- Digest semanal manager (`weeklyDigestJob`)
- UI benchmark "vs similares"
- Sentiment AI

## Copy del email

El CTA pasa por `/click` (no link directo al front). Copy corto, humano, es-CL. Footer opt-out.
