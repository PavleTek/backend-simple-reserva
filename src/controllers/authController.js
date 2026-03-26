const prisma = require('../lib/prisma');
const planService = require('../services/planService');
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
const { SUPPORTED_COUNTRIES } = require('../utils/timezone');

function stripUser(user, lastLoginOverride) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    lastName: user.lastName,
    role: user.role,
    country: user.country,
    lastLogin: lastLoginOverride || user.lastLogin,
    createdAt: user.createdAt
  };
}

async function getRestaurantsForUser(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      ownedOrganization: {
        include: { restaurants: { select: { id: true, name: true, slug: true } } }
      },
      managedOrganizations: {
        include: {
          organization: true,
          restaurantAssignments: {
            include: { restaurant: { select: { id: true, name: true, slug: true } } }
          }
        }
      }
    }
  });

  if (!user) return [];

  const restaurants = [];

  // If owner, they see all restaurants in their organization
  if (user.ownedOrganization) {
    user.ownedOrganization.restaurants.forEach(r => {
      restaurants.push({
        id: r.id,
        name: r.name,
        slug: r.slug,
        role: 'restaurant_owner'
      });
    });
  }

  // If manager, they see assigned restaurants
  user.managedOrganizations.forEach(mo => {
    mo.restaurantAssignments.forEach(ra => {
      restaurants.push({
        id: ra.restaurant.id,
        name: ra.restaurant.name,
        slug: ra.restaurant.slug,
        role: 'restaurant_manager'
      });
    });
  });

  return restaurants;
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
    const { email: identifier, password } = req.body;
    console.log('[AUTH] POST /login received', { email: identifier || '(missing)', hasPassword: !!password });

    if (!identifier || !password) {
      console.log('[AUTH] Login rejected: missing email or password');
      res.status(400).json({ error: 'Se requiere usuario/email y contraseña' });
      return;
    }

    const user = await prisma.user.findFirst({
      where: {
        email: {
          equals: identifier,
          mode: 'insensitive'
        }
      }
    });

    if (!user) {
      console.log('[AUTH] Login failed: no user found for email', identifier);
      res.status(401).json({ error: 'Credenciales inválidas' });
      return;
    }

    console.log('[AUTH] User found', { userId: user.id, email: user.email, role: user.role });

    const isPasswordValid = await comparePassword(password, user.hashedPassword);
    if (!isPasswordValid) {
      console.log('[AUTH] Login failed: invalid password for', user.email);
      res.status(401).json({ error: 'Credenciales inválidas' });
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
        console.log('[AUTH] Login: 2FA verification required for', user.email);
        const tempToken = generateTempToken(userWithoutPassword);
        res.status(200).json({
          message: 'Se requiere verificación 2FA',
          requiresTwoFactor: true,
          tempToken
        });
        return;
      } else {
        console.log('[AUTH] Login: 2FA setup required for', user.email);
        const tempToken = generateTempToken(userWithoutPassword);
        res.status(200).json({
          message: 'Se requiere configuración de 2FA',
          requiresTwoFactorSetup: true,
          tempToken
        });
        return;
      }
    }

    const token = generateToken(userWithoutPassword);
    const restaurants = await getRestaurantsForUser(user.id);
    console.log('[AUTH] Login success', { userId: user.id, email: user.email, restaurantsCount: restaurants.length });

    res.status(200).json({
      message: 'Inicio de sesión exitoso',
      user: userWithoutPassword,
      restaurants,
      token
    });
  } catch (error) {
    console.error('[AUTH] Login error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const register = async (req, res) => {
  try {
    const { email, password, name, lastName, restaurantName, restaurantSlug, plan, country } = req.body;

    if (!email || !password || !restaurantName) {
      res.status(400).json({ error: 'Se requiere email, contraseña y nombre del restaurante' });
      return;
    }

    const selectedCountry = country && SUPPORTED_COUNTRIES.includes(country) ? country : 'CL';

    const existingUser = await prisma.user.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive'
        }
      }
    });

    if (existingUser) {
      res.status(409).json({ error: 'El email ya está en uso' });
      return;
    }

    const slug = restaurantSlug || generateSlug(restaurantName);

    const existingSlug = await prisma.restaurant.findUnique({
      where: { slug }
    });

    if (existingSlug) {
      res.status(409).json({ error: 'El slug del restaurante ya está en uso. Por favor elige otro nombre o slug.' });
      return;
    }

    const hashedPassword = await hashPassword(password);

    const trialEndsAt = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 14);
      return d;
    })();

    const result = await prisma.$transaction(async (tx) => {
      // 1. Create User
      const user = await tx.user.create({
        data: {
          email: email.toLowerCase().trim(),
          name: name || null,
          lastName: lastName || null,
          hashedPassword,
          role: 'restaurant_owner',
          country: selectedCountry,
        }
      });

      // 2. Find default plan
      const planSKU = plan || 'plan-profesional';
      const defaultPlan = await tx.plan.findFirst({
        where: { productSKU: planSKU, isDefault: true }
      }) || await tx.plan.findFirst({
        where: { isDefault: true }
      });

      if (!defaultPlan) {
        throw new Error('No se encontró una configuración de plan válida');
      }

      // 3. Create Organization
      const organization = await tx.restaurantOrganization.create({
        data: {
          name: `${restaurantName} Org`,
          ownerId: user.id,
          planId: defaultPlan.id,
          trialEndsAt,
        }
      });

      // 4. Create Restaurant
      const restaurant = await tx.restaurant.create({
        data: {
          organizationId: organization.id,
          name: restaurantName,
          slug,
          timezone: null,
        }
      });

      // 5. Create Subscription on Org
      await tx.subscription.create({
        data: {
          organizationId: organization.id,
          planId: defaultPlan.id,
          status: 'trial'
        }
      });

      return { user, restaurant };
    });

    const userWithoutPassword = stripUser(result.user);
    const token = generateToken(userWithoutPassword);
    const restaurants = await getRestaurantsForUser(result.user.id);

    try {
      const panelUrl = (process.env.FRONTEND_RESTAURANT_PORTAL_URL || 'http://localhost:5175').replace(/\/$/, '');
      const { sendWelcomeEmail } = require('../services/notificationService');
      await sendWelcomeEmail({
        email: result.user.email,
        restaurantName: result.restaurant.name,
        panelUrl,
      });
    } catch (err) {
      console.error('[Auth] Welcome email failed:', err?.message ?? err);
    }

    res.status(201).json({
      message: 'Registro exitoso',
      user: userWithoutPassword,
      restaurant: {
        id: result.restaurant.id,
        name: result.restaurant.name,
        slug: result.restaurant.slug
      },
      restaurants,
      token,
      requiresPayment: false,
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const addRestaurant = async (req, res) => {
  try {
    const userId = req.user.id;
    if (req.user.role === 'super_admin') {
      res.status(403).json({ error: 'Los super administradores no pueden crear restaurantes' });
      return;
    }

    const org = await prisma.restaurantOrganization.findUnique({
      where: { ownerId: userId },
    });
    if (!org) {
      res.status(403).json({ error: 'Solo los propietarios pueden agregar nuevas ubicaciones' });
      return;
    }

    const { name, slug: providedSlug, address, phone, email } = req.body;
    if (!name || !name.trim()) {
      res.status(400).json({ error: 'El nombre del restaurante es obligatorio' });
      return;
    }

    const canAdd = await planService.canAddLocation(userId, true);
    if (!canAdd.allowed) {
      res.status(403).json({ error: canAdd.reason || 'Límite de locales alcanzado. Actualiza tu plan para agregar más.' });
      return;
    }

    const base = (providedSlug && providedSlug.trim()) ? providedSlug.trim() : name.trim();
    const slug = generateSlug(base);

    const existing = await prisma.restaurant.findUnique({ where: { slug } });
    if (existing) {
      res.status(400).json({ error: 'Ya existe un restaurante con ese identificador. Intenta con otro nombre.' });
      return;
    }

    const result = await prisma.restaurant.create({
      data: {
        organizationId: org.id,
        name: name.trim(),
        slug,
        address: address?.trim() || null,
        phone: phone?.trim() || null,
        email: email?.trim() || null,
        timezone: null,
      },
    });

    const restaurants = await getRestaurantsForUser(userId);

    res.status(201).json({
      message: 'Ubicación agregada',
      restaurant: {
        id: result.id,
        name: result.name,
        slug: result.slug,
        address: result.address,
        phone: result.phone,
        email: result.email,
      },
      restaurants,
    });
  } catch (error) {
    console.error('Add restaurant error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const getProfile = async (req, res) => {
  try {
    const restaurants = req.user.role === 'super_admin'
      ? []
      : await getRestaurantsForUser(req.user.id);
    res.status(200).json({
      message: 'Perfil obtenido correctamente',
      user: req.user,
      restaurants
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const updateProfile = async (req, res) => {
  try {
    const currentUser = req.user;
    const { email, name, lastName, country } = req.body;
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
        res.status(409).json({ error: 'El email ya está en uso' });
        return;
      }
    }

    const updateData = {};
    if (email !== undefined) updateData.email = email.toLowerCase().trim();
    if (name !== undefined) updateData.name = name;
    if (lastName !== undefined) updateData.lastName = lastName;
    if (country !== undefined && SUPPORTED_COUNTRIES.includes(country)) updateData.country = country;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData
    });

    res.status(200).json({
      message: 'Perfil actualizado correctamente',
      user: stripUser(updatedUser)
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const updatePassword = async (req, res) => {
  try {
    const currentUser = req.user;
    const { password } = req.body;

    if (!password) {
      res.status(400).json({ error: 'La contraseña es obligatoria' });
      return;
    }

    const hashedPassword = await hashPassword(password);

    await prisma.user.update({
      where: { id: currentUser.id },
      data: { hashedPassword }
    });

    res.status(200).json({
      message: 'Contraseña actualizada correctamente'
    });
  } catch (error) {
    console.error('Update password error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const verifyTwoFactor = async (req, res) => {
  try {
    const { tempToken, code } = req.body;

    if (!tempToken || !code) {
      res.status(400).json({ error: 'Se requiere token temporal y código 2FA' });
      return;
    }

    let decoded;
    try {
      decoded = verifyToken(tempToken);
    } catch {
      res.status(401).json({ error: 'Token temporal inválido o expirado' });
      return;
    }

    if (!decoded.isTempToken) {
      res.status(400).json({ error: 'Tipo de token inválido' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user || !user.twoFactorSecret || !user.twoFactorEnabled) {
      res.status(400).json({ error: '2FA no está activado para este usuario' });
      return;
    }

    const isValid = verifyTwoFactorToken(user.twoFactorSecret, code);

    if (!isValid) {
      res.status(401).json({ error: 'Código 2FA inválido' });
      return;
    }

    const now = new Date();
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: now }
    });

    const userWithoutPassword = stripUser(user, now.toISOString());
    const token = generateToken(userWithoutPassword);
    const restaurants = await getRestaurantsForUser(user.id);

    res.status(200).json({
      message: 'Inicio de sesión exitoso',
      user: userWithoutPassword,
      restaurants,
      token
    });
  } catch (error) {
    console.error('Verify 2FA error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
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
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const setupTwoFactorMandatory = async (req, res) => {
  try {
    const { tempToken } = req.body;

    if (!tempToken) {
      res.status(400).json({ error: 'Se requiere token temporal' });
      return;
    }

    let decoded;
    try {
      decoded = verifyToken(tempToken);
    } catch {
      res.status(401).json({ error: 'Token temporal inválido o expirado' });
      return;
    }

    if (!decoded.isTempToken) {
      res.status(400).json({ error: 'Tipo de token inválido' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    if (user.twoFactorEnabled && user.twoFactorSecret) {
      res.status(400).json({ error: '2FA ya está activado para este usuario' });
      return;
    }

    const secret = generateSecret();

    const config = await prisma.configuration.findFirst();
    const appName = config?.appName || 'SimpleReserva';

    const qrCodeDataUrl = await generateQRCode(secret, user.email, appName);

    res.status(200).json({
      message: 'Configuración de 2FA iniciada',
      secret,
      qrCode: qrCodeDataUrl
    });
  } catch (error) {
    console.error('Setup 2FA mandatory error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const verifyTwoFactorSetup = async (req, res) => {
  try {
    const userId = req.user.id;
    const { secret, code } = req.body;

    if (!secret || !code) {
      res.status(400).json({ error: 'Se requiere secreto y código de verificación' });
      return;
    }

    const isValid = verifyTwoFactorToken(secret, code);

    if (!isValid) {
      res.status(401).json({ error: 'Código de verificación inválido' });
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
      message: '2FA activado correctamente'
    });
  } catch (error) {
    console.error('Verify 2FA setup error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const verifyTwoFactorSetupMandatory = async (req, res) => {
  try {
    const { tempToken, secret, code } = req.body;

    if (!tempToken || !secret || !code) {
      res.status(400).json({ error: 'Se requiere token temporal, secreto y código de verificación' });
      return;
    }

    let decoded;
    try {
      decoded = verifyToken(tempToken);
    } catch {
      res.status(401).json({ error: 'Token temporal inválido o expirado' });
      return;
    }

    if (!decoded.isTempToken) {
      res.status(400).json({ error: 'Tipo de token inválido' });
      return;
    }

    const isValid = verifyTwoFactorToken(secret, code);

    if (!isValid) {
      res.status(401).json({ error: 'Código de verificación inválido' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' });
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

    const restaurants = await getRestaurantsForUser(user.id);

    res.status(200).json({
      message: '2FA activado correctamente',
      token,
      user: userWithoutPassword,
      restaurants
    });
  } catch (error) {
    console.error('Verify 2FA setup mandatory error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const disableTwoFactor = async (req, res) => {
  try {
    const userId = req.user.id;

    const config = await prisma.configuration.findFirst();
    const system2FAEnabled = config?.twoFactorEnabled || false;

    if (system2FAEnabled) {
      res.status(400).json({
        error: 'No se puede desactivar 2FA. Está habilitado a nivel del sistema para todos los usuarios.'
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
      message: '2FA desactivado correctamente'
    });
  } catch (error) {
    console.error('Disable 2FA error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
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
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    const config = await prisma.configuration.findFirst();
    const system2FAEnabled = config?.twoFactorEnabled || false;

    res.status(200).json({
      message: 'Estado de 2FA obtenido correctamente',
      enabled: user.twoFactorEnabled && !!user.twoFactorSecret,
      userEnabled: user.userEnabledTwoFactor,
      systemEnabled: system2FAEnabled
    });
  } catch (error) {
    console.error('Get 2FA status error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const requestRecoveryCode = async (req, res) => {
  try {
    const { tempToken } = req.body;

    if (!tempToken) {
      res.status(400).json({ error: 'Se requiere token temporal' });
      return;
    }

    let decoded;
    try {
      decoded = verifyToken(tempToken);
    } catch {
      res.status(401).json({ error: 'Token temporal inválido o expirado' });
      return;
    }

    if (!decoded.isTempToken) {
      res.status(400).json({ error: 'Tipo de token inválido' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      res.status(400).json({ error: '2FA no está activado para este usuario' });
      return;
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (user.twoFactorRecoveryCodeExpires && user.twoFactorRecoveryCodeExpires > oneHourAgo) {
      const minutesRemaining = Math.ceil(
        (user.twoFactorRecoveryCodeExpires.getTime() - Date.now()) / (1000 * 60)
      );
      res.status(429).json({
        error: `Por favor espera antes de solicitar otro código de recuperación. Intenta en ${minutesRemaining} minutos.`
      });
      return;
    }

    const config = await prisma.configuration.findFirst();
    if (!config || !config.recoveryEmailSenderId) {
      res.status(500).json({ error: 'Email de recuperación no configurado. Contacta a un administrador.' });
      return;
    }

    const recoveryEmailSender = await prisma.emailSender.findUnique({
      where: { id: config.recoveryEmailSenderId }
    });

    if (!recoveryEmailSender) {
      res.status(500).json({ error: 'Remitente de email de recuperación no encontrado. Contacta a un administrador.' });
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
        subject: `${appName} - Código de recuperación 2FA`,
        content: `Tu código de recuperación 2FA es: ${recoveryCode}\n\nEste código expirará en 15 minutos.\n\nSi no solicitaste este código, ignora este correo.`,
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
      res.status(500).json({ error: 'Error al enviar el correo de recuperación. Intenta más tarde.' });
      return;
    }

    res.status(200).json({
      message: 'Código de recuperación enviado a tu correo'
    });
  } catch (error) {
    console.error('Request recovery code error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const verifyRecoveryCode = async (req, res) => {
  try {
    const { tempToken, code } = req.body;

    if (!tempToken || !code) {
      res.status(400).json({ error: 'Se requiere token temporal y código de recuperación' });
      return;
    }

    let decoded;
    try {
      decoded = verifyToken(tempToken);
    } catch {
      res.status(401).json({ error: 'Token temporal inválido o expirado' });
      return;
    }

    if (!decoded.isTempToken) {
      res.status(400).json({ error: 'Tipo de token inválido' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      res.status(400).json({ error: '2FA no está activado para este usuario' });
      return;
    }

    if (!user.twoFactorRecoveryCode || !user.twoFactorRecoveryCodeExpires) {
      res.status(400).json({ error: 'No se encontró código de recuperación. Solicita uno nuevo.' });
      return;
    }

    if (new Date() > user.twoFactorRecoveryCodeExpires) {
      res.status(400).json({ error: 'El código de recuperación ha expirado. Solicita uno nuevo.' });
      return;
    }

    const isValid = verifyRecoveryCodeUtil(code, user.twoFactorRecoveryCode);

    if (!isValid) {
      res.status(401).json({ error: 'Código de recuperación inválido' });
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
    const restaurants = await getRestaurantsForUser(user.id);

    res.status(200).json({
      message: 'Código de recuperación verificado. 2FA desactivado. Puedes configurarlo de nuevo desde tu perfil.',
      user: userWithoutPassword,
      restaurants,
      token
    });
  } catch (error) {
    console.error('Verify recovery code error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const requestPasswordReset = async (req, res) => {
  try {
    const { email: identifier } = req.body;

    if (!identifier) {
      res.status(400).json({ error: 'El usuario/email es obligatorio' });
      return;
    }

    const user = await prisma.user.findFirst({
      where: {
        email: {
          equals: identifier,
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
          error: `Espera antes de solicitar otro código de restablecimiento. Intenta en ${minutesRemaining} minutos.`
        });
        return;
      }

      const config = await prisma.configuration.findFirst();
      if (!config || !config.recoveryEmailSenderId) {
        res.status(500).json({ error: 'Email de restablecimiento no configurado. Contacta a un administrador.' });
        return;
      }

      const recoveryEmailSender = await prisma.emailSender.findUnique({
        where: { id: config.recoveryEmailSenderId }
      });

      if (!recoveryEmailSender) {
        res.status(500).json({ error: 'Remitente de email de restablecimiento no encontrado. Contacta a un administrador.' });
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
          subject: `${appName} - Código de restablecimiento de contraseña`,
          content: `Tu código de restablecimiento de contraseña es: ${resetCode}\n\nEste código expirará en 15 minutos.\n\nSi no solicitaste este código, ignora este correo y tu contraseña permanecerá igual.`,
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
        res.status(500).json({ error: 'Error al enviar el correo de restablecimiento. Intenta más tarde.' });
        return;
      }
    }

    res.status(200).json({
      message: 'Si existe una cuenta con ese email, se ha enviado un código de restablecimiento.'
    });
  } catch (error) {
    console.error('Request password reset error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const verifyPasswordReset = async (req, res) => {
  try {
    const { email: identifier, code, newPassword } = req.body;

    if (!identifier || !code || !newPassword) {
      res.status(400).json({ error: 'Se requiere usuario/email, código y nueva contraseña' });
      return;
    }

    const user = await prisma.user.findFirst({
      where: {
        email: {
          equals: identifier,
          mode: 'insensitive'
        }
      }
    });

    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    if (!user.passwordResetCode || !user.passwordResetCodeExpires) {
      res.status(400).json({ error: 'No se encontró código de restablecimiento. Solicita uno nuevo.' });
      return;
    }

    if (new Date() > user.passwordResetCodeExpires) {
      res.status(400).json({ error: 'El código de restablecimiento ha expirado. Solicita uno nuevo.' });
      return;
    }

    const isValid = verifyRecoveryCodeUtil(code, user.passwordResetCode);

    if (!isValid) {
      res.status(401).json({ error: 'Código de restablecimiento inválido' });
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
      message: 'Contraseña restablecida correctamente. Ya puedes iniciar sesión con tu nueva contraseña.'
    });
  } catch (error) {
    console.error('Verify password reset error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const getRestaurantsTodaySummary = async (req, res) => {
  try {
    if (req.user.role === 'super_admin') {
      return res.json({ locations: [] });
    }
    
    const restaurants = await getRestaurantsForUser(req.user.id);
    const locationIds = restaurants.map((r) => r.id);
    
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const reservations = await prisma.reservation.findMany({
      where: {
        restaurantId: { in: locationIds },
        dateTime: { gte: todayStart, lt: todayEnd },
        status: 'confirmed',
      },
      select: { restaurantId: true, partySize: true },
    });

    const byRestaurant = {};
    for (const r of reservations) {
      if (!byRestaurant[r.restaurantId]) {
        byRestaurant[r.restaurantId] = { count: 0, covers: 0 };
      }
      byRestaurant[r.restaurantId].count++;
      byRestaurant[r.restaurantId].covers += r.partySize || 0;
    }

    const locations = restaurants.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      role: r.role,
      todayReservations: byRestaurant[r.id]?.count ?? 0,
      todayCovers: byRestaurant[r.id]?.covers ?? 0,
    }));

    res.json({ date: today.toISOString().split('T')[0], locations });
  } catch (error) {
    console.error('Get restaurants today summary error:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = {
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
};
