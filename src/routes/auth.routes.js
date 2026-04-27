const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticateToken } = require('../middleware/authentication');
const promoCodeService = require('../services/promoCodeService');

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en un minuto.' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados registros desde esta IP. Intenta de nuevo en una hora.' },
});

// Shared limiter for promo code validation to prevent code enumeration
const promoCodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.' },
});
const {
  login,
  register,
  addRestaurant,
  getRestaurantsTodaySummary,
  getProfile,
  updateProfile,
  updatePassword,
  completeDashboardTour,
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

router.post('/login', loginLimiter, login);
router.post('/register', registerLimiter, register);

router.post('/promo-code/validate', promoCodeLimiter, async (req, res, next) => {
  try {
    const { code, email } = req.body;
    if (!code || !code.trim()) {
      return res.status(400).json({ valid: false, error: 'El código no puede estar vacío.' });
    }
    const { promoCode } = await promoCodeService.validatePromoCode({ code, email: email || '' });
    res.json({
      valid: true,
      planName: promoCode.plan?.name ?? null,
      durationValue: promoCode.durationValue,
      durationUnit: promoCode.durationUnit,
      lockedToEmail: !!promoCode.lockedToEmail,
    });
  } catch (error) {
    // ValidationError means the code is invalid/expired/etc — return structured response
    if (error.statusCode === 400) {
      return res.status(400).json({ valid: false, error: error.message });
    }
    next(error);
  }
});
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
router.patch('/dashboard-tour/complete', authenticateToken, completeDashboardTour);
router.get('/2fa/status', authenticateToken, getTwoFactorStatus);
router.post('/2fa/setup', authenticateToken, setupTwoFactor);
router.post('/2fa/verify-setup', authenticateToken, verifyTwoFactorSetup);
router.post('/2fa/disable', authenticateToken, disableTwoFactor);

module.exports = router;
