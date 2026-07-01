'use strict';

const RESERVATION_FIELDS = [
  { key: 'date', label: 'Fecha', required: true },
  { key: 'startTime', label: 'Hora inicio', required: true },
  { key: 'endTime', label: 'Hora fin', required: false },
  { key: 'durationMinutes', label: 'Duración (minutos)', required: false },
  { key: 'status', label: 'Estado', required: false },
  { key: 'customerName', label: 'Nombre cliente', required: true },
  { key: 'customerPhone', label: 'Teléfono', required: false },
  { key: 'customerEmail', label: 'Email', required: false },
  { key: 'partySize', label: 'Comensales', required: true },
  { key: 'tableLabel', label: 'Mesa', required: false },
  { key: 'zoneName', label: 'Zona', required: false },
  { key: 'notes', label: 'Notas', required: false },
];

const HEADER_ALIASES = {
  date: ['fecha', 'fecha_reserva', 'date', 'dia'],
  startTime: ['hora_inicio', 'hora', 'start_time', 'time', 'inicio'],
  endTime: ['hora_fin', 'end_time', 'fin'],
  durationMinutes: ['duracion_minutos', 'duracion', 'duration', 'duration_minutes'],
  status: ['estado', 'status', 'estado_reserva'],
  customerName: ['nombre_cliente', 'cliente', 'customer_name', 'nombre', 'name'],
  customerPhone: ['telefono', 'phone', 'telefono_cliente', 'celular', 'movil'],
  customerEmail: ['email', 'customer_email', 'correo', 'mail'],
  partySize: ['comensales', 'party_size', 'personas', 'pax', 'guests', 'covers'],
  tableLabel: ['mesa', 'table', 'mesa_nombre', 'table_label'],
  zoneName: ['zona', 'zone', 'area', 'sector'],
  notes: ['notas', 'notes', 'observaciones', 'comentarios'],
};

const STATUS_MAP = {
  confirmed: 'confirmed',
  confirmada: 'confirmed',
  confirmado: 'confirmed',
  pending: 'confirmed',
  pendiente: 'confirmed',
  cancelled: 'cancelled',
  cancelada: 'cancelled',
  cancelado: 'cancelled',
  completed: 'completed',
  completada: 'completed',
  completado: 'completed',
  no_show: 'no_show',
  'no show': 'no_show',
  noshow: 'no_show',
  'no asistio': 'no_show',
  'no asistió': 'no_show',
};

const IMPORT_STATUSES = [
  'uploaded',
  'validated',
  'queued',
  'processing',
  'completed',
  'failed',
  'rolling_back',
  'rolled_back',
];

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 100_000;
const CHUNK_SIZE = 500;
const ROLLBACK_DAYS = 30;
const MAX_RETRIES = 3;

const DEFAULT_OPTIONS = {
  timezone: null,
  matchingStrategy: 'both',
  conflictPolicy: 'skip',
  notifyFutureReminders: true,
  affectAnalytics: false,
  appendMetaToNotes: false,
};

module.exports = {
  RESERVATION_FIELDS,
  HEADER_ALIASES,
  STATUS_MAP,
  IMPORT_STATUSES,
  MAX_FILE_BYTES,
  MAX_ROWS,
  CHUNK_SIZE,
  ROLLBACK_DAYS,
  MAX_RETRIES,
  DEFAULT_OPTIONS,
};
