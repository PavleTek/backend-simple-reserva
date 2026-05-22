/** Global and per-restaurant role identifiers. */
const ROLES = {
  SUPER_ADMIN: 'super_admin',
  OWNER: 'restaurant_owner',
  MANAGER: 'restaurant_manager',
  HOST: 'restaurant_host',
};

const RESTAURANT_ROLES = [ROLES.OWNER, ROLES.MANAGER, ROLES.HOST];

/** Floor operations: reservations, tables status, walk-ins. */
const ROLES_OPERATIONAL = [ROLES.OWNER, ROLES.MANAGER, ROLES.HOST];

/** Local configuration: schedules, zones, menus, blocked slots, uploads. */
const ROLES_CONFIG = [ROLES.OWNER, ROLES.MANAGER];

/** Organization administration. */
const ROLES_OWNER = [ROLES.OWNER];

/** Team listing (not invite). */
const ROLES_TEAM_VIEW = [ROLES.OWNER, ROLES.MANAGER];

const RESTAURANT_ROLE_LABELS = {
  [ROLES.OWNER]: 'Propietario',
  [ROLES.MANAGER]: 'Gerente',
  [ROLES.HOST]: 'Anfitrión',
};

module.exports = {
  ROLES,
  RESTAURANT_ROLES,
  ROLES_OPERATIONAL,
  ROLES_CONFIG,
  ROLES_OWNER,
  ROLES_TEAM_VIEW,
  RESTAURANT_ROLE_LABELS,
};
