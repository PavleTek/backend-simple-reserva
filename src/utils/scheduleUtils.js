/**
 * Returns an array of [startMinutes, endMinutes] pairs representing valid service windows.
 * @param {Object} schedule - The schedule record for a specific day.
 * @param {string} scheduleMode - "continuous" or "service_periods".
 */
function getScheduleWindows(schedule, scheduleMode = 'continuous') {
  if (scheduleMode === 'service_periods') {
    const windows = [];
    const periods = [
      [schedule.breakfastStartTime, schedule.breakfastEndTime],
      [schedule.lunchStartTime, schedule.lunchEndTime],
      [schedule.dinnerStartTime, schedule.dinnerEndTime],
    ];

    for (const [start, end] of periods) {
      if (start && end) {
        const [startH, startM] = start.split(':').map(Number);
        const [endH, endM] = end.split(':').map(Number);
        windows.push([startH * 60 + startM, endH * 60 + endM]);
      }
    }
    return windows;
  }

  // Default: continuous mode
  const [openH, openM] = schedule.openTime.split(':').map(Number);
  const [closeH, closeM] = schedule.closeTime.split(':').map(Number);
  const openMin = openH * 60 + openM;
  const closeMin = closeH * 60 + closeM;

  return [[openMin, closeMin]];
}

/**
 * Returns true if a slot starting at timeMin with duration slotDuration fits within any schedule window.
 */
function isSlotInSchedule(schedule, timeMin, slotDuration, scheduleMode = 'continuous') {
  const windows = getScheduleWindows(schedule, scheduleMode);
  const slotEnd = timeMin + slotDuration;
  return windows.some(([start, end]) => timeMin >= start && slotEnd <= end);
}

/**
 * Generates time slots for availability. With split schedules, slots are generated for each window.
 */
function generateTimeSlots(schedule, slotDuration, scheduleMode = 'continuous') {
  const windows = getScheduleWindows(schedule, scheduleMode);
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

/**
 * Resolves the slot duration in minutes for a given party size.
 * Uses durationRules if available, otherwise falls back to restaurant.defaultSlotDurationMinutes.
 * Rules are ordered by minPartySize (asc); the first matching rule (minPartySize <= partySize <= maxPartySize) is used.
 */
function resolveDuration(restaurant, partySize, durationRules) {
  if (durationRules && durationRules.length > 0) {
    const sorted = [...durationRules].sort((a, b) => a.minPartySize - b.minPartySize);
    const rule = sorted.find(
      (r) => partySize >= r.minPartySize && partySize <= r.maxPartySize
    );
    if (rule) return rule.durationMinutes;
  }
  return restaurant?.defaultSlotDurationMinutes ?? 60;
}

module.exports = {
  getScheduleWindows,
  isSlotInSchedule,
  generateTimeSlots,
  resolveDuration,
};
