const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');

function generateSecret() {
  return speakeasy.generateSecret({
    name: process.env.APP_NAME || 'SimpleReserva',
    length: 32
  }).base32;
}

async function generateQRCode(secret, email, issuer = null) {
  const appName = issuer || process.env.APP_NAME || 'SimpleReserva';
  const otpauthUrl = speakeasy.otpauthURL({
    secret: secret,
    label: email,
    issuer: appName,
    encoding: 'base32'
  });

  try {
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
    return qrCodeDataUrl;
  } catch (error) {
    console.error('Error generating QR code:', error);
    throw new Error('Failed to generate QR code');
  }
}

function verifyToken(secret, token, window = 2) {
  try {
    return speakeasy.totp.verify({
      secret: secret,
      encoding: 'base32',
      token: token,
      window: window
    });
  } catch (error) {
    console.error('Error verifying token:', error);
    return false;
  }
}

function generateRecoveryCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function verifyRecoveryCode(code, hashedCode) {
  const computedHash = hashRecoveryCode(code);
  return computedHash === hashedCode;
}

module.exports = {
  generateSecret,
  generateQRCode,
  verifyToken,
  generateRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCode
};
