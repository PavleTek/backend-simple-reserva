const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Upload a file to R2
 * @param {string} key - The object key (path in bucket)
 * @param {Buffer} buffer - File content
 * @param {string} contentType - MIME type
 * @returns {Promise<void>}
 */
async function uploadFile(key, buffer, contentType) {
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });

  await client.send(command);
}

/**
 * Delete a file from R2
 * @param {string} key - The object key
 * @returns {Promise<void>}
 */
async function deleteFile(key) {
  const command = new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
  });

  await client.send(command);
}

/**
 * Get a file stream from R2 (for proxying)
 * @param {string} key - The object key
 * @returns {Promise<ReadableStream>}
 */
async function getFileStream(key) {
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
  });

  const response = await client.send(command);
  return response.Body;
}

/**
 * Get the public URL for an R2 object
 * @param {string} key - The object key
 * @returns {string|null}
 */
function getPublicUrl(key) {
  if (!process.env.R2_PUBLIC_URL) return null;
  
  // Ensure R2_PUBLIC_URL doesn't end with a slash
  const baseUrl = process.env.R2_PUBLIC_URL.replace(/\/$/, '');
  return `${baseUrl}/${key}`;
}

module.exports = {
  uploadFile,
  deleteFile,
  getFileStream,
  getPublicUrl,
};
