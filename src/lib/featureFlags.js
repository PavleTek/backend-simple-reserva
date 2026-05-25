'use strict';

/** Cross-midnight and booking acceptance are always enabled (flags removed in v1 rollout). */
function isCrossMidnightEnabled() {
  return true;
}

function isBookingAcceptanceEnabled() {
  return true;
}

module.exports = {
  isCrossMidnightEnabled,
  isBookingAcceptanceEnabled,
};
