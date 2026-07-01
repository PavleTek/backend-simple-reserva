# Plantilla de importación de reservas (CSV)

Usa este archivo como referencia para migrar reservas desde otro sistema (AgendaPro, Excel, Calendly exportado a CSV, etc.) hacia SimpleReserva.

## Descarga

En el panel admin: **Operación → Migraciones → Nueva migración → Descargar plantilla CSV**.

## Columnas soportadas

| Columna CSV | Obligatorio | Descripción | Ejemplo |
|-------------|-------------|-------------|---------|
| `fecha` | Sí | Fecha de la reserva (`YYYY-MM-DD`) | `2026-01-15` |
| `hora_inicio` | Sí | Hora de inicio (`HH:mm`, 24 h) | `19:30` |
| `hora_fin` | No | Hora de fin; alternativa a duración | `21:30` |
| `duracion_minutos` | No | Minutos de duración; si falta, usa la del restaurante | `90` |
| `estado` | No | `confirmed`, `pending`, `cancelled`, `completed`, `no_show` (default: `confirmed`) | `confirmed` |
| `nombre_cliente` | Sí | Nombre del comensal | `Juan Pérez` |
| `telefono` | Según config | Teléfono con código país | `+56912345678` |
| `email` | Según config | Correo del comensal | `juan@ejemplo.cl` |
| `comensales` | Sí | Número de personas (entero ≥ 1) | `4` |
| `mesa` | No | Etiqueta de mesa existente en SimpleReserva | `Mesa 1` |
| `zona` | No | Nombre de zona (ayuda a ubicar la mesa) | `Sala principal` |
| `notas` | No | Notas visibles en la reserva | `Cumpleaños` |

## Alias de columnas (auto-detectados)

El sistema también reconoce encabezados en inglés o variantes comunes:

- `date`, `fecha_reserva` → fecha
- `start_time`, `hora`, `time` → hora_inicio
- `end_time`, `hora_fin` → hora_fin
- `duration`, `duracion` → duracion_minutos
- `status`, `estado_reserva` → estado
- `customer_name`, `cliente`, `nombre` → nombre_cliente
- `phone`, `telefono_cliente`, `celular` → telefono
- `customer_email`, `correo` → email
- `party_size`, `personas`, `pax` → comensales
- `table`, `mesa_nombre` → mesa
- `zone`, `area` → zona
- `notes`, `observaciones` → notas

## Lo que SimpleReserva **no** almacena hoy

Estos campos de otros sistemas **no se importan** (puedes ponerlos en `notas` si necesitas conservarlos como texto):

- ID externo de reserva
- Servicio / tratamiento / menú específico
- Profesional / colaborador asignado
- Precio o estado de pago

## Reglas importantes

1. **Zona horaria**: se usa la del restaurante (`America/Santiago` por defecto en Chile).
2. **Reservas pasadas**: no bloquean disponibilidad; no envían confirmaciones.
3. **Reservas futuras confirmadas**: se validan contra mesas disponibles; no se envía email de confirmación al importar (evita spam).
4. **Recordatorios**: las reservas futuras pueden recibir recordatorio el día anterior (configurable al importar).
5. **Duplicados**: por defecto se omiten filas que coinciden con una reserva existente (misma fecha/hora + email o teléfono).
6. **Codificación**: guarda el CSV en UTF-8. Excel: “Guardar como CSV UTF-8”.

## Estados válidos

| Valor en CSV | Significado en SimpleReserva |
|--------------|------------------------------|
| `confirmed` / `confirmada` | Confirmada |
| `pending` / `pendiente` | Se importa como confirmada |
| `cancelled` / `cancelada` | Cancelada |
| `completed` / `completada` | Completada (solo pasado) |
| `no_show` / `no asistio` | No-show (solo pasado) |
