/**
 * Returns an array of [startMinutes, endMinutes] pairs representing valid service windows.
 * If breakStartTime/breakEndTime are set, returns two windows: [open, breakStart) and [breakEnd, close].
 * Otherwise returns one window [open, close].
 */
function getScheduleWindows(schedule) {
  const [openH, openM] = schedule.openTime.split(':').map(Number);
  const [closeH, closeM] = schedule.closeTime.split(':').map(Number);
  const openMin = openH * 60 + openM;
  const closeMin = closeH * 60 + closeM;

  if (schedule.breakStartTime && schedule.breakEndTime) {
    const [breakStartH, breakStartM] = schedule.breakStartTime.split(':').map(Number);
    const [breakEndH, breakEndM] = schedule.breakEndTime.split(':').map(Number);
    const breakStartMin = breakStartH * 60 + breakStartM;
    const breakEndMin = breakEndH * 60 + breakEndM;
    return [
      [openMin, breakStartMin],
      [breakEndMin, closeMin],
    ];
  }

  return [[openMin, closeMin]];
}

/**
 * Returns true if a slot starting at timeMin with duration slotDuration fits within any schedule window.
 */
function isSlotInSchedule(schedule, timeMin, slotDuration) {
  const windows = getScheduleWindows(schedule);
  const slotEnd = timeMin + slotDuration;
  return windows.some(([start, end]) => timeMin >= start && slotEnd <= end);
}

/**
 * Generates time slots for availability. With split schedules, slots are generated for each window.
 */
function generateTimeSlots(schedule, slotDuration) {
  const windows = getScheduleWindows(schedule);
  const slots = [];
  for (const [startMin, endMin] of windows) {
    for (let m = startMin; m + slotDuration <= endMin; m += slotDuration) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      const time = `${hh}:${mm}`;
      slots.push({ time, startMin: m, endMin: m + slotDuration });
    }
  }
  return slots;
}

module.exports = {
  getScheduleWindows,
  isSlotInSchedule,
  generateTimeSlots,
};
