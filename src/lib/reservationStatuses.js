/** Estados que ocupan mesa / cupo en el motor de disponibilidad. */
const ACTIVE_TABLE_STATUSES = ['confirmed', 'arrived'];

/** Minutos de gracia antes de tratar una confirmada como atrasada. Alinear con operationalSemantics.LATE_GRACE_MINUTES. */
const LATE_GRACE_MINUTES = 10;

/** Transiciones permitidas desde el panel operacional. */
const ALLOWED_STATUS_TRANSITIONS = {
  confirmed: ['arrived', 'completed', 'cancelled', 'no_show'],
  arrived: ['completed', 'cancelled', 'no_show'],
  completed: ['confirmed'],
  cancelled: ['confirmed'],
  no_show: ['confirmed'],
};

function canTransitionStatus(from, to) {
  if (!from || !to || from === to) return false;
  const allowed = ALLOWED_STATUS_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

module.exports = {
  ACTIVE_TABLE_STATUSES,
  ALLOWED_STATUS_TRANSITIONS,
  LATE_GRACE_MINUTES,
  canTransitionStatus,
};
