/**
 * @deprecated Import from ../services/reservationSlotService.js
 * Re-exports preserved for backward-compatible requires.
 */
const slotService = require('../services/reservationSlotService');

module.exports = {
  getScheduleWindows: slotService.getOperatingWindows,
  isSlotInSchedule: (
    schedule,
    timeMin,
    slotDuration,
    scheduleMode = 'continuous',
    reservationEndPolicy = 'STRICT_END',
    reservationWindowMode = 'same_as_schedule',
    customWindows = []
  ) =>
    slotService.isSlotInSchedule(
      schedule,
      timeMin,
      slotDuration,
      scheduleMode,
      reservationEndPolicy,
      reservationWindowMode,
      customWindows
    ),
  generateTimeSlots: (schedule, slotDuration, scheduleMode = 'continuous') =>
    slotService.generateTimeSlots({
      mode: 'legacy',
      schedule,
      scheduleMode,
      reservationDurationMinutes: slotDuration,
    }),
  resolveDuration: slotService.resolveDuration,
};
