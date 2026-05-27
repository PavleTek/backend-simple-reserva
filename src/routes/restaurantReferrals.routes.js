const express = require('express');
const prisma = require('../lib/prisma');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const referralService = require('../services/referralService');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);
router.use(authenticateRestaurantRoles(['restaurant_owner']));

router.get('/', async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.params.restaurantId },
      select: { organizationId: true },
    });
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurante no encontrado' });
    }
    const summary = await referralService.getReferralSummary(restaurant.organizationId);
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

router.get('/list', async (req, res, next) => {
  try {
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: req.params.restaurantId },
      select: { organizationId: true },
    });
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurante no encontrado' });
    }
    const list = await referralService.listReferralsForOrganization(restaurant.organizationId);
    res.json({ referrals: list });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
