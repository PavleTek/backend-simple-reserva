# Plantilla de importación de reservas (CSV)

Usa este archivo como referencia para migrar reservas desde otro sistema (AgendaPro, Excel, Calendly exportado a CSV, etc.) hacia SimpleReserva.

## Descarga

En el panel admin: **Operación → Migraciones → Nueva migración → Descargar plantilla CSV**.

## Columnas mínimas

Solo **fecha** y **hora_inicio** son obligatorias. Todo lo demás es opcional: importamos con los datos que tengas, aunque vengan incompletos del sistema anterior.

| Columna CSV | ¿Obligatorio? | Si falta… |
|-------------|---------------|-----------|
| `fecha` | **Sí** | Fila inválida |
| `hora_inicio` | **Sí** | Fila inválida |
| `hora_fin` | No | Se calcula duración o se usa la del restaurante |
| `duracion_minutos` | No | Default del restaurante |
| `estado` | No | `confirmed` |
| `nombre_cliente` | No | `Cliente (importado)` |
| `telefono` | No | Vacío |
| `email` | No | Vacío |
| `comensales` | No | `2` |
| `mesa` / `zona` | No | Sin mesa asignada (histórico) o auto-asignación (futuro) |
| `notas` | No | Vacío |

## Estados (`estado`) — qué poner en el CSV

Deja la celda **vacía** si no sabes el estado: se importa como **confirmada**.

| Valor en CSV | Resultado en SimpleReserva | Cuándo usarlo |
|--------------|----------------------------|---------------|
| *(vacío)* | `confirmed` | No sabes el estado / reserva activa |
| `confirmed`, `confirmada`, `confirmado` | `confirmed` | Reserva confirmada |
| `pending`, `pendiente` | `confirmed` | Pendiente en sistema viejo → confirmada acá |
| `cancelled`, `cancelada`, `cancelado` | `cancelled` | Cancelada |
| `completed`, `completada`, `completado` | `completed` | **Solo pasado** — ya se atendió |
| `no_show`, `no asistio`, `no asistió` | `no_show` | **Solo pasado** — no llegó |

`completed` y `no_show` en fechas futuras se rechazan en validación.

## Alias de columnas (auto-detectados)

- `date`, `fecha_reserva` → fecha
- `start_time`, `hora`, `time` → hora_inicio
- `end_time`, `hora_fin` → hora_fin
- `duration`, `duracion` → duracion_minutos
- `status`, `estado_reserva` → estado
- `customer_name`, `cliente`, `nombre` → nombre_cliente
- `phone`, `celular` → telefono
- `customer_email`, `correo` → email
- `party_size`, `personas`, `pax` → comensales
- `table`, `mesa_nombre` → mesa
- `zone`, `area` → zona
- `notes`, `observaciones` → notas

## Notificaciones al importar

| Tipo de reserva | Cliente | Equipo (restaurante) |
|-----------------|---------|----------------------|
| **Pasada** | Nada | Nada |
| **Futura confirmada** | Sin email de confirmación (ya pudo enviarlo el sistema anterior). Recordatorio al cliente **sí**, si está activo en la migración y hay email/teléfono | Alerta según **configuración de notificaciones** del restaurante (misma regla que reserva manual) |
| **Futura cancelada / completada** | Nada | Nada |

## Lo que SimpleReserva **no** almacena hoy

Puedes pegar info extra en `notas`:

- ID externo, servicio, profesional, precio, pago

## Reglas útiles

1. Zona horaria: la del restaurante (`America/Santiago` en Chile).
2. Reservas pasadas: no bloquean mesas; cero emails.
3. Reservas futuras confirmadas: validación de disponibilidad.
4. Duplicados: se omiten si coinciden fecha/hora + contacto (o fecha/hora + comensales + mesa si no hay contacto).
5. CSV en UTF-8.
