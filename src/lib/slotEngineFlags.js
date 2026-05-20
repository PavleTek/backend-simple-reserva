'use strict';

function envFlag(name, defaultValue = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return v === 'true' || v === '1';
}

function isClockAlignedEnabled() {
  return envFlag('ENABLE_CLOCK_ALIGNED_SLOTS', false);
}

function isReservationWindowsEnabled() {
  return envFlag('ENABLE_RESERVATION_WINDOWS', false);
}

function isSlotSimulatorEnabled() {
  return envFlag('ENABLE_SLOT_SIMULATOR', false);
}

function isShadowSlotEngineEnabled() {
  return envFlag('SHADOW_SLOT_ENGINE', false);
}

module.exports = {
  isClockAlignedEnabled,
  isReservationWindowsEnabled,
  isSlotSimulatorEnabled,
  isShadowSlotEngineEnabled,
};
