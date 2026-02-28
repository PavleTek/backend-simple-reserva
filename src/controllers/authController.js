const prisma = require('../lib/prisma');
const { comparePassword, hashPassword } = require('../utils/password');
const { generateToken, generateTempToken, verifyToken } = require('../utils/jwt');
const {
  generateSecret,
  generateQRCode,
  verifyToken: verifyTwoFactorToken,
  generateRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCode: verifyRecoveryCodeUtil
} = require('../utils/twoFactor');
const { sendEmail } = require('../services/emailService');

function stripUser(user, lastLoginOverride) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    lastName: user.lastName,
    role: user.role,
    restaurantId: user.restaurantId,
    lastLogin: lastLoginOverride || user.lastLogin,
    createdAt: user.createdAt
  };
}

function generateSlug(restaurantName) {
  const base = restaurantName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const rand = Math.random().toString(36).substring(2, 6);
  return `${base}-${rand}`;
}

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const user = await prisma.user.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive'
        }
      }
    });

    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const isPasswordValid = await comparePassword(password, user.hashedPassword);
    if (!isPasswordValid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const now = new Date();
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: now }
    });

    const userWithoutPassword = stripUser(user, now.toISOString());

    const config = await prisma.configuration.findFirst();
    const system2FAEnabled = config?.twoFactorEnabled || false;
    const requires2FA = system2FAEnabled || user.userEnabledTwoFactor;

    if (requires2FA) {
      const userHas2FA = user.twoFactorSecret && user.twoFactorEnabled;

      if (userHas2FA) {
        const tempToken = generateTempToken(userWithoutPassword);
        res.status(200).json({
          message: '2FA verification required',
          requiresTwoFactor: true,
          tempToken
        });
        return;
      } else {
        const tempToken = generateTempToken(userWithoutPassword);
        res.status(200).json({
          message: '2FA setup required',
          requiresTwoFactorSetup: true,
          tempToken
        });
        return;
      }
    }

    const token = generateToken(userWithoutPassword);

    res.status(200).json({
      message: 'Login successful',
      user: userWithoutPassword,
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const register = async (req, res) => {
  try {
    const { email, password, name, lastName, restaurantName, restaurantSlug } = req.body;

    if (!email || !password || !restaurantName) {
      res.status(400).json({ error: 'Email, password, and restaurant name are required' });
      return;
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive'
        }
      }
    });

    if (existingUser) {
      res.status(409).json({ error: 'Email already in use' });
      return;
    }

    const slug = restaurantSlug || generateSlug(restaurantName);

    const existingSlug = await prisma.restaurant.findUnique({
      where: { slug }
    });

    if (existingSlug) {
      res.status(409).json({ error: 'Restaurant slug already taken. Please choose a different name or slug.' });
      return;
    }

    const hashedPassword = await hashPassword(password);

    const result = await prisma.$transaction(async (tx) => {
      const restaurant = await tx.restaurant.create({
        data: {
          name: restaurantName,
          slug
        }
      });

      const user = await tx.user.create({
        data: {
          email: email.toLowerCase().trim(),
          name: name || null,
          lastName: lastName || null,
          hashedPassword,
          role: 'owner',
          restaurantId: restaurant.id
        }
      });

      await tx.subscription.create({
        data: {
          restaurantId: restaurant.id,
          plan: 'free',
          status: 'active'
        }
      });

      return { user, restaurant };
    });

    const userWithoutPassword = stripUser(result.user);
    const token = generateToken(userWithoutPassword);

    res.status(201).json({
      message: 'Registration successful',
      user: userWithoutPassword,
      restaurant: {
        id: result.restaurant.id,
        name: result.restaurant.name,
        slug: result.restaurant.slug
      },
      token
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const getProfile = async (req, res) => {
  try {
    res.status(200).json({
      message: 'Profile retrieved successfully',
      user: req.user
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const updateProfile = async (req, res) => {
  try {
    const currentUser = req.user;
    const { email, name, lastName } = req.body;
    const userId = currentUser.id;

    if (email) {
      const duplicateUser = await prisma.user.findFirst({
        where: {
          AND: [
            { id: { not: userId } },
            {
              email: {
                equals: email,
                mode: 'insensitive'
              }
            }
          ]
        }
      });

      if (duplicateUser) {
        res.status(409).json({ error: 'Email already in use' });
        return;
      }
    }

    const updateData = {};
    if (email !== undefined) updateData.email = email.toLowerCase().trim();
    if (name !== undefined) updateData.name = name;
    if (lastName !== undefined) updateData.lastName = lastName;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData
    });

    res.status(200).json({
      message: 'Profile updated successfully',
      user: stripUser(updatedUser)
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const updatePassword = async (req, res) => {
  try {
    const currentUser = req.user;
    const { password } = req.body;

    if (!password) {
      res.status(400).json({ error: 'Password is required' });
      return;
    }

    const hashedPassword = await hashPassword(password);

    await prisma.user.update({
      where: { id: currentUser.id },
      data: { hashedPassword }
    });

    res.status(200).json({
      message: 'Password updated successfully'
    });
  } catch (error) {
    console.error('Update password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const verifyTwoFactor = async (req, res) => {
  try {
    const { tempToken, code } = req.body;

    if (!tempToken || !code) {
      res.status(400).json({ error: 'Temporary token and 2FA code are required' });
      return;
    }

    let decoded;
    try {
      decoded = verifyToken(tempToken);
    } catch {
      res.status(401).json({ error: 'Invalid or expired temporary token' });
      return;
    }

    if (!decoded.isTempToken) {
      res.status(400).json({ error: 'Invalid token type' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user || !user.twoFactorSecret || !user.twoFactorEnabled) {
      res.status(400).json({ error: '2FA is not enabled for this user' });
      return;
    }

    const isValid = verifyTwoFactorToken(user.twoFactorSecret, code);

    if (!isValid) {
      res.status(401).json({ error: 'Invalid 2FA code' });
      return;
    }

    const now = new Date();
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: now }
    });

    const userWithoutPassword = stripUser(user, now.toISOString());
    const token = generateToken(userWithoutPassword);

    res.status(200).json({
      message: 'Login successful',
      user: userWithoutPassword,
      token
    });
  } catch (error) {
    console.error('Verify 2FA error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const setupTwoFactor = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (user.twoFactorEnabled && user.twoFactorSecret) {
      res.status(400).json({ error: '2FA is already enabled for this user' });
      return;
    }

    const secret = generateSecret();

    const config = await prisma.configuration.findFirst();
    const appName = config?.appName || 'SimpleReserva';

    const qrCodeDataUrl = await generateQRCode(secret, user.email, appName);

    res.status(200).json({
      message: '2FA setup initiated',
      secret,
      qrCode: qrCodeDataUrl
    });
  } catch (error) {
    console.error('Setup 2FA error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const setupTwoFactorMandatory = async (req, res) => {
  try {
    const { tempToken } = req.body;

    if (!tempToken) {
      res.status(400).json({ error: 'Temporary token is required' });
      return;
    }

    let decoded;
    try {
      decoded = verifyToken(tempToken);
    } catch {
      res.status(401).json({ error: 'Invalid or expired temporary token' });
      return;
    }

    if (!decoded.isTempToken) {
      res.status(400).json({ error: 'Invalid token type' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (user.twoFactorEnabled && user.twoFactorSecret) {
      res.status(400).json({ error: '2FA is already enabled for this user' });
      return;
    }

    const secret = generateSecret();

    const config = await prisma.configuration.findFirst();
    const appName = config?.appName || 'SimpleReserva';

    const qrCodeDataUrl = await generateQRCode(secret, user.email, appName);

    res.status(200).json({
      message: '2FA setup initiated',
      secret,
      qrCode: qrCodeDataUrl
    });
  } catch (error) {
    console.error('Setup 2FA mandatory error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const verifyTwoFactorSetup = async (req, res) => {
  try {
    const userId = req.user.id;
    const { secret, code } = req.body;

    if (!secret || !code) {
      res.status(400).json({ error: 'Secret and verification code are required' });
      return;
    }

    const isValid = verifyTwoFactorToken(secret, code);

    if (!isValid) {
      res.status(401).json({ error: 'Invalid verification code' });
      return;
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorSecret: secret,
        twoFactorEnabled: true,
        userEnabledTwoFactor: true
      }
    });

    res.status(200).json({
      message: '2FA enabled successfully'
    });
  } catch (error) {
    console.error('Verify 2FA setup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const verifyTwoFactorSetupMandatory = async (req, res) => {
  try {
    const { tempToken, secret, code } = req.body;

    if (!tempToken || !secret || !code) {
      res.status(400).json({ error: 'Temporary token, secret, and verification code are required' });
      return;
    }

    let decoded;
    try {
      decoded = verifyToken(tempToken);
    } catch {
      res.status(401).json({ error: 'Invalid or expired temporary token' });
      return;
    }

    if (!decoded.isTempToken) {
      res.status(400).json({ error: 'Invalid token type' });
      return;
    }

    const isValid = verifyTwoFactorToken(secret, code);

    if (!isValid) {
      res.status(401).json({ error: 'Invalid verification code' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const now = new Date();

    await prisma.user.update({
      where: { id: decoded.userId },
      data: {
        twoFactorSecret: secret,
        twoFactorEnabled: true,
        userEnabledTwoFactor: true,
        lastLogin: now
      }
    });

    const userWithoutPassword = stripUser(user, now.toISOString());
    const token = generateToken(userWithoutPassword);

    res.status(200).json({
      message: '2FA enabled successfully',
      token,
      user: userWithoutPassword
    });
  } catch (error) {
    console.error('Verify 2FA setup mandatory error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const disableTwoFactor = async (req, res) => {
  try {
    const userId = req.user.id;

    const config = await prisma.configuration.findFirst();
    const system2FAEnabled = config?.twoFactorEnabled || false;

    if (system2FAEnabled) {
      res.status(400).json({
        error: 'Cannot disable 2FA. System-wide 2FA is enabled and required for all users.'
      });
      return;
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorSecret: null,
        twoFactorEnabled: false,
        userEnabledTwoFactor: false
      }
    });

    res.status(200).json({
      message: '2FA disabled successfully'
    });
  } catch (error) {
    console.error('Disable 2FA error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const getTwoFactorStatus = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        twoFactorEnabled: true,
        twoFactorSecret: true,
        userEnabledTwoFactor: true
      }
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const config = await prisma.configuration.findFirst();
    const system2FAEnabled = config?.twoFactorEnabled || false;

    res.status(200).json({
      message: '2FA status retrieved successfully',
      enabled: user.twoFactorEnabled && !!user.twoFactorSecret,
      userEnabled: user.userEnabledTwoFactor,
      systemEnabled: system2FAEnabled
    });
  } catch (error) {
    console.error('Get 2FA status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const requestRecoveryCode = async (req, res) => {
  try {
    const { tempToken } = req.body;

    if (!tempToken) {
      res.status(400).json({ error: 'Temporary token is required' });
      return;
    }

    let decoded;
    try {
      decoded = verifyToken(tempToken);
    } catch {
      res.status(401).json({ error: 'Invalid or expired temporary token' });
      return;
    }

    if (!decoded.isTempToken) {
      res.status(400).json({ error: 'Invalid token type' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      res.status(400).json({ error: '2FA is not enabled for this user' });
      return;
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (user.twoFactorRecoveryCodeExpires && user.twoFactorRecoveryCodeExpires > oneHourAgo) {
      const minutesRemaining = Math.ceil(
        (user.twoFactorRecoveryCodeExpires.getTime() - Date.now()) / (1000 * 60)
      );
      res.status(429).json({
        error: `Please wait before requesting another recovery code. Try again in ${minutesRemaining} minutes.`
      });
      return;
    }

    const config = await prisma.configuration.findFirst();
    if (!config || !config.recoveryEmailSenderId) {
      res.status(500).json({ error: 'Recovery email is not configured. Please contact an administrator.' });
      return;
    }

    const recoveryEmailSender = await prisma.emailSender.findUnique({
      where: { id: config.recoveryEmailSenderId }
    });

    if (!recoveryEmailSender) {
      res.status(500).json({ error: 'Recovery email sender not found. Please contact an administrator.' });
      return;
    }

    const recoveryCode = generateRecoveryCode();
    const hashedCode = hashRecoveryCode(recoveryCode);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorRecoveryCode: hashedCode,
        twoFactorRecoveryCodeExpires: expiresAt
      }
    });

    const fromEmail = recoveryEmailSender.email;
    const appName = config.appName || 'SimpleReserva';

    try {
      await sendEmail({
        fromEmail,
        toEmails: [user.email],
        subject: `${appName} - 2FA Recovery Code`,
        content: `Your 2FA recovery code is: ${recoveryCode}\n\nThis code will expire in 15 minutes.\n\nIf you did not request this code, please ignore this email.`,
        isHtml: false
      });
    } catch (emailError) {
      console.error('Error sending recovery email:', emailError);
      await prisma.user.update({
        where: { id: user.id },
        data: {
          twoFactorRecoveryCode: null,
          twoFactorRecoveryCodeExpires: null
        }
      });
      res.status(500).json({ error: 'Failed to send recovery email. Please try again later.' });
      return;
    }

    res.status(200).json({
      message: 'Recovery code sent to your email address'
    });
  } catch (error) {
    console.error('Request recovery code error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const verifyRecoveryCode = async (req, res) => {
  try {
    const { tempToken, code } = req.body;

    if (!tempToken || !code) {
      res.status(400).json({ error: 'Temporary token and recovery code are required' });
      return;
    }

    let decoded;
    try {
      decoded = verifyToken(tempToken);
    } catch {
      res.status(401).json({ error: 'Invalid or expired temporary token' });
      return;
    }

    if (!decoded.isTempToken) {
      res.status(400).json({ error: 'Invalid token type' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      res.status(400).json({ error: '2FA is not enabled for this user' });
      return;
    }

    if (!user.twoFactorRecoveryCode || !user.twoFactorRecoveryCodeExpires) {
      res.status(400).json({ error: 'No recovery code found. Please request a new recovery code.' });
      return;
    }

    if (new Date() > user.twoFactorRecoveryCodeExpires) {
      res.status(400).json({ error: 'Recovery code has expired. Please request a new one.' });
      return;
    }

    const isValid = verifyRecoveryCodeUtil(code, user.twoFactorRecoveryCode);

    if (!isValid) {
      res.status(401).json({ error: 'Invalid recovery code' });
      return;
    }

    const now = new Date();

    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorSecret: null,
        twoFactorEnabled: false,
        userEnabledTwoFactor: false,
        twoFactorRecoveryCode: null,
        twoFactorRecoveryCodeExpires: null,
        lastLogin: now
      }
    });

    const userWithoutPassword = stripUser(user, now.toISOString());
    const token = generateToken(userWithoutPassword);

    res.status(200).json({
      message: 'Recovery code verified successfully. 2FA has been disabled. You can set it up again from your profile.',
      user: userWithoutPassword,
      token
    });
  } catch (error) {
    console.error('Verify recovery code error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const requestPasswordReset = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    const user = await prisma.user.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive'
        }
      }
    });

    if (user) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (user.passwordResetCodeExpires && user.passwordResetCodeExpires > oneHourAgo) {
        const minutesRemaining = Math.ceil(
          (user.passwordResetCodeExpires.getTime() - Date.now()) / (1000 * 60)
        );
        res.status(429).json({
          error: `Please wait before requesting another password reset code. Try again in ${minutesRemaining} minutes.`
        });
        return;
      }

      const config = await prisma.configuration.findFirst();
      if (!config || !config.recoveryEmailSenderId) {
        res.status(500).json({ error: 'Password reset email is not configured. Please contact an administrator.' });
        return;
      }

      const recoveryEmailSender = await prisma.emailSender.findUnique({
        where: { id: config.recoveryEmailSenderId }
      });

      if (!recoveryEmailSender) {
        res.status(500).json({ error: 'Password reset email sender not found. Please contact an administrator.' });
        return;
      }

      const resetCode = generateRecoveryCode();
      const hashedCode = hashRecoveryCode(resetCode);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetCode: hashedCode,
          passwordResetCodeExpires: expiresAt
        }
      });

      const fromEmail = recoveryEmailSender.email;
      const appName = config.appName || 'SimpleReserva';

      try {
        await sendEmail({
          fromEmail,
          toEmails: [user.email],
          subject: `${appName} - Password Reset Code`,
          content: `Your password reset code is: ${resetCode}\n\nThis code will expire in 15 minutes.\n\nIf you did not request this code, please ignore this email and your password will remain unchanged.`,
          isHtml: false
        });
      } catch (emailError) {
        console.error('Error sending password reset email:', emailError);
        await prisma.user.update({
          where: { id: user.id },
          data: {
            passwordResetCode: null,
            passwordResetCodeExpires: null
          }
        });
        res.status(500).json({ error: 'Failed to send password reset email. Please try again later.' });
        return;
      }
    }

    res.status(200).json({
      message: 'If an account with that email exists, a password reset code has been sent.'
    });
  } catch (error) {
    console.error('Request password reset error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const verifyPasswordReset = async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      res.status(400).json({ error: 'Email, code, and new password are required' });
      return;
    }

    const user = await prisma.user.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive'
        }
      }
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (!user.passwordResetCode || !user.passwordResetCodeExpires) {
      res.status(400).json({ error: 'No password reset code found. Please request a new one.' });
      return;
    }

    if (new Date() > user.passwordResetCodeExpires) {
      res.status(400).json({ error: 'Password reset code has expired. Please request a new one.' });
      return;
    }

    const isValid = verifyRecoveryCodeUtil(code, user.passwordResetCode);

    if (!isValid) {
      res.status(401).json({ error: 'Invalid password reset code' });
      return;
    }

    const hashedPassword = await hashPassword(newPassword);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        hashedPassword,
        passwordResetCode: null,
        passwordResetCodeExpires: null
      }
    });

    res.status(200).json({
      message: 'Password has been reset successfully. You can now login with your new password.'
    });
  } catch (error) {
    console.error('Verify password reset error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  login,
  register,
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
};
