const express = require('express');
const { authenticateToken, authorizeRestaurant, authenticateRestaurantRoles } = require('../middleware/authentication');
const { ROLES_OWNER } = require('../auth/roles');
const ownershipTransferService = require('../services/ownershipTransferService');

const router = express.Router({ mergeParams: true });

router.use(authenticateToken);
router.use(authorizeRestaurant);

router.get(
  '/',
  authenticateRestaurantRoles(ROLES_OWNER),
  async (req, res, next) => {
    try {
      const data = await ownershipTransferService.getTransferStateForOrg(
        req.activeRestaurant.restaurantId,
        req.user.id,
      );
      res.json(data);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/',
  authenticateRestaurantRoles(ROLES_OWNER),
  async (req, res, next) => {
    try {
      const { email, outgoingOwnerDisposition, confirmText } = req.body || {};
      const transfer = await ownershipTransferService.initiateTransfer({
        restaurantId: req.activeRestaurant.restaurantId,
        actorUserId: req.user.id,
        email,
        outgoingOwnerDisposition,
        confirmText,
      });
      res.status(201).json(transfer);
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/:id',
  authenticateRestaurantRoles(ROLES_OWNER),
  async (req, res, next) => {
    try {
      const transfer = await ownershipTransferService.cancelTransfer({
        transferId: req.params.id,
        restaurantId: req.activeRestaurant.restaurantId,
        actorUserId: req.user.id,
      });
      res.json(transfer);
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/:id/resend',
  authenticateRestaurantRoles(ROLES_OWNER),
  async (req, res, next) => {
    try {
      const result = await ownershipTransferService.resendTransfer({
        transferId: req.params.id,
        restaurantId: req.activeRestaurant.restaurantId,
        actorUserId: req.user.id,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

module.exports = router;
