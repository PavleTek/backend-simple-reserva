const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/authentication');
const {
  login,
  register,
  addRestaurant,
  getRestaurantsTodaySummary,
  getProfile,
  updateProfile,
  updatePassword,
  verifyTwoFactor,
  setupTwoFactor,
  setupTwoFactorMandatory,
  verifyTwoFactorSetup,
  verifyTwoFactorSetupMandatory,
  disableTwoFactor,
  getTwoFactorStatus,
  requestRecoveryCode,
  verifyRecoveryCode,
  requestPasswordReset,
  verifyPasswordReset
} = require('../controllers/authController');

router.post('/login', login);
router.post('/register', register);
router.post('/2fa/verify', verifyTwoFactor);
router.post('/2fa/setup-mandatory', setupTwoFactorMandatory);
router.post('/2fa/verify-setup-mandatory', verifyTwoFactorSetupMandatory);
router.post('/2fa/recovery/request', requestRecoveryCode);
router.post('/2fa/recovery/verify', verifyRecoveryCode);
router.post('/password-reset/request', requestPasswordReset);
router.post('/password-reset/verify', verifyPasswordReset);

router.post('/restaurants', authenticateToken, addRestaurant);
router.get('/restaurants/today-summary', authenticateToken, getRestaurantsTodaySummary);
router.get('/profile', authenticateToken, getProfile);
router.put('/profile', authenticateToken, updateProfile);
router.put('/profile/password', authenticateToken, updatePassword);
router.get('/2fa/status', authenticateToken, getTwoFactorStatus);
router.post('/2fa/setup', authenticateToken, setupTwoFactor);
router.post('/2fa/verify-setup', authenticateToken, verifyTwoFactorSetup);
router.post('/2fa/disable', authenticateToken, disableTwoFactor);

module.exports = router;
