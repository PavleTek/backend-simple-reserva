const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Upload a logo to the dedicated logos R2 bucket.
 * @param {string} key - Object key (path in bucket), e.g. "{restaurantId}/logo-{ts}.png"
 * @param {Buffer} buffer - File bytes
 * @param {string} contentType - MIME type
 */
async function uploadLogo(key, buffer, contentType) {
  const command = new PutObjectCommand({
    Bucket: process.env.R2_LOGOS_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });
  await client.send(command);
}

/**
 * Delete a logo from the logos R2 bucket.
 * @param {string} key - Object key
 */
async function deleteLogo(key) {
  const command = new DeleteObjectCommand({
    Bucket: process.env.R2_LOGOS_BUCKET_NAME,
    Key: key,
  });
  await client.send(command);
}

/**
 * Build the full public URL for a logo key.
 * @param {string} key - Object key
 * @returns {string}
 */
function getLogosPublicUrl(key) {
  const baseUrl = (process.env.R2_LOGOS_PUBLIC_URL || '').replace(/\/$/, '');
  return `${baseUrl}/${key}`;
}

/**
 * Extract the R2 object key from a full public logo URL.
 * Returns null if the URL does not match the configured base URL.
 * @param {string} url - Absolute public URL
 * @returns {string|null}
 */
function keyFromLogoUrl(url) {
  if (!url || !process.env.R2_LOGOS_PUBLIC_URL) return null;
  const baseUrl = process.env.R2_LOGOS_PUBLIC_URL.replace(/\/$/, '');
  if (!url.startsWith(baseUrl + '/')) return null;
  return url.slice(baseUrl.length + 1);
}

module.exports = {
  uploadLogo,
  deleteLogo,
  getLogosPublicUrl,
  keyFromLogoUrl,
};
