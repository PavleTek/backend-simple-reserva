const express = require('express');
const { authenticateToken } = require('../middleware/authentication');
const ownershipTransferService = require('../services/ownershipTransferService');

const router = express.Router();

router.get('/accept/:token', async (req, res, next) => {
  try {
    const details = await ownershipTransferService.getTransferPublicDetails(req.params.token);
    res.json(details);
  } catch (error) {
    next(error);
  }
});

router.post('/accept/:token', authenticateToken, async (req, res, next) => {
  try {
    const result = await ownershipTransferService.acceptTransfer({
      rawToken: req.params.token,
      user: req.user,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/decline/:token', authenticateToken, async (req, res, next) => {
  try {
    const result = await ownershipTransferService.declineTransfer({
      rawToken: req.params.token,
      user: req.user,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
