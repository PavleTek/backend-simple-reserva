'use strict';

/**
 * slotEngineFlags.js
 *
 * Feature flags del motor de slots. En v3 todos los flags legacy fueron eliminados.
 * Este archivo se mantiene por compatibilidad con imports existentes pero
 * solo exporta valores constantes (sin lectura de env vars).
 *
 * Flags eliminados:
 * - ENABLE_CLOCK_ALIGNED_SLOTS → motor v3 siempre es clock-aligned
 * - SHADOW_SLOT_ENGINE → el motor es único, sin shadow
 * - ENABLE_RESERVATION_WINDOWS → ventanas disponibles para todos los restaurantes
 * - ENABLE_SLOT_SIMULATOR → reemplazado por AvailabilityPreview
 */

module.exports = {
  isClockAlignedEnabled: () => true,
  isReservationWindowsEnabled: () => true,
  isSlotSimulatorEnabled: () => false,
  isShadowSlotEngineEnabled: () => false,
};
