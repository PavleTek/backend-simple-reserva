const { ROLES } = require('./roles');

/**
 * Permission keys mapped to restaurant roles that may use them.
 * Owner inherits all manager permissions where listed; host is operational subset.
 */
const ROLE_PERMISSIONS = {
  [ROLES.OWNER]: '*',
  [ROLES.MANAGER]: [
    'reservation.view',
    'reservation.create',
    'reservation.edit.operational',
    'reservation.edit.structural',
    'reservation.cancel',
    'reservation.status.completed',
    'reservation.status.no_show',
    'reservation.bulk',
    'table.status.view',
    'table.assign',
    'table.structure.edit',
    'schedule.view',
    'schedule.edit',
    'availability.edit',
    'menu.edit',
    'feedback.view',
    'feedback.alerts.manage',
    'team.view',
    'billing.view',
    'upload.assets',
    'export.customers',
  ],
  [ROLES.HOST]: [
    'reservation.view',
    'reservation.create',
    'reservation.edit.operational',
    'reservation.cancel',
    'reservation.status.completed',
    'reservation.status.no_show',
    'table.status.view',
    'table.assign',
  ],
};

function roleHasPermission(role, permission) {
  if (role === ROLES.OWNER || role === ROLES.SUPER_ADMIN) return true;
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  if (perms === '*') return true;
  return perms.includes(permission);
}

function assertHostReservationEditWindow(reservationDateTime, now = new Date()) {
  const HOURS_BEFORE = 2;
  const DAYS_AHEAD = 14;
  const msBefore = HOURS_BEFORE * 60 * 60 * 1000;
  const msAfter = DAYS_AHEAD * 24 * 60 * 60 * 1000;
  const dt = reservationDateTime instanceof Date ? reservationDateTime : new Date(reservationDateTime);
  const min = new Date(now.getTime() - msBefore);
  const max = new Date(now.getTime() + msAfter);
  if (dt < min || dt > max) {
    return {
      allowed: false,
      message: 'Esta reserva está fuera del rango que puedes editar. Solicita al gerente o al dueño.',
    };
  }
  return { allowed: true };
}

function assertHostPartySizeIncrease(oldSize, newSize) {
  const HOST_PARTY_MAX = 12;
  if (newSize > HOST_PARTY_MAX && newSize > oldSize) {
    return {
      allowed: false,
      message: `No puedes aumentar el grupo a más de ${HOST_PARTY_MAX} comensales. Solicita al gerente.`,
    };
  }
  return { allowed: true };
}

module.exports = {
  ROLE_PERMISSIONS,
  roleHasPermission,
  assertHostReservationEditWindow,
  assertHostPartySizeIncrease,
};
