'use strict';

const { DateTime } = require('luxon');
const { timeToMinutes } = require('./windows');
const { getDayOfWeekInTimezone } = require('../../utils/timezone');
const { isCrossMidnightEnabled } = require('../../lib/featureFlags');

function addDaysToDateStr(dateStr, days) {
  return DateTime.fromISO(dateStr, { zone: 'utc' }).plus({ days }).toFormat('yyyy-MM-dd');
}

function getScheduleOpenMeta(schedule, scheduleMode = 'continuous') {
  if (!schedule) {
    return { openMin: 0, closesNextDay: false };
  }
  if (scheduleMode === 'service_periods' && schedule.dinnerStartTime && schedule.dinnerEndTime) {
    return {
      openMin: timeToMinutes(schedule.dinnerStartTime),
      closesNextDay: !!schedule.dinnerEndsNextDay && isCrossMidnightEnabled(),
    };
  }
  return {
    openMin: timeToMinutes(schedule.openTime ?? '00:00'),
    closesNextDay: !!schedule.closesNextDay && isCrossMidnightEnabled(),
  };
}

/**
 * businessDate = day the service night opened (anchor day).
 */
function computeBusinessDate(calendarDateStr, timeStr, schedule, scheduleMode = 'continuous', timezone) {
  if (!schedule || !isCrossMidnightEnabled()) {
    return calendarDateStr;
  }

  const { openMin, closesNextDay } = getScheduleOpenMeta(schedule, scheduleMode);
  const timeMin = timeToMinutes(timeStr);
  const dow = getDayOfWeekInTimezone(calendarDateStr, timezone);

  if (closesNextDay && timeMin < openMin) {
    if (schedule.dayOfWeek === dow) {
      return addDaysToDateStr(calendarDateStr, -1);
    }
    const prevDow = dow === 0 ? 6 : dow - 1;
    if (schedule.dayOfWeek === prevDow) {
      return calendarDateStr;
    }
  }

  if (schedule.dayOfWeek != null && schedule.dayOfWeek === dow) {
    return calendarDateStr;
  }

  return calendarDateStr;
}

function resolveCalendarDateFromBusinessDate(businessDateStr, timeStr, schedule, scheduleMode = 'continuous') {
  if (!schedule || !isCrossMidnightEnabled()) {
    return { calendarDateStr: businessDateStr, dayOffset: 0 };
  }

  const { openMin, closesNextDay } = getScheduleOpenMeta(schedule, scheduleMode);
  const timeMin = timeToMinutes(timeStr);

  if (closesNextDay && timeMin < openMin) {
    return {
      calendarDateStr: addDaysToDateStr(businessDateStr, 1),
      dayOffset: 1,
    };
  }

  return { calendarDateStr: businessDateStr, dayOffset: 0 };
}

function currentBusinessDateInTZ(timezone, schedules, now = new Date()) {
  const nowDt = DateTime.fromJSDate(now).setZone(timezone);
  const todayStr = nowDt.toFormat('yyyy-MM-dd');
  const nowMin = nowDt.hour * 60 + nowDt.minute;
  const todayDow = nowDt.weekday === 7 ? 0 : nowDt.weekday;

  const yesterdayDow = todayDow === 0 ? 6 : todayDow - 1;
  const yesterdaySchedule = schedules.find((s) => s.dayOfWeek === yesterdayDow && s.isActive !== false);
  if (yesterdaySchedule?.closesNextDay && isCrossMidnightEnabled()) {
    const closeMin = timeToMinutes(yesterdaySchedule.closeTime);
    if (nowMin < closeMin) {
      return nowDt.minus({ days: 1 }).toFormat('yyyy-MM-dd');
    }
  }

  return todayStr;
}

module.exports = {
  addDaysToDateStr,
  computeBusinessDate,
  resolveCalendarDateFromBusinessDate,
  currentBusinessDateInTZ,
  getScheduleOpenMeta,
};
