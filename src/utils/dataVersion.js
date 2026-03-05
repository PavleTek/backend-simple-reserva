const prisma = require('../lib/prisma');

/**
 * Increments the dataVersion counter for a specific restaurant.
 * This is used to notify the frontend that data has changed and needs to be re-fetched.
 * @param {string} restaurantId 
 */
async function incrementDataVersion(restaurantId) {
  try {
    if (!restaurantId) return;
    await prisma.restaurant.update({
      where: { id: restaurantId },
      data: { dataVersion: { increment: 1 } },
    });
  } catch (error) {
    console.error('[DataVersion] Failed to increment version for restaurant:', restaurantId, error.message);
  }
}

module.exports = { incrementDataVersion };
