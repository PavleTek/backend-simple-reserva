'use strict';

const fs = require('fs');
const path = require('path');
const r2Service = require('../r2Service');

const LOCAL_ROOT = path.join(__dirname, '../../../uploads/migrations');

function isR2Configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_NAME,
  );
}

function localPath(key) {
  return path.join(LOCAL_ROOT, key);
}

async function ensureLocalDir(key) {
  const full = localPath(key);
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  return full;
}

async function uploadBuffer(key, buffer, contentType) {
  if (isR2Configured()) {
    await r2Service.uploadFile(key, buffer, contentType);
    return key;
  }
  const full = await ensureLocalDir(key);
  await fs.promises.writeFile(full, buffer);
  return key;
}

async function readBuffer(key) {
  if (isR2Configured()) {
    const stream = await r2Service.getFileStream(key);
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  return fs.promises.readFile(localPath(key));
}

async function deleteObject(key) {
  if (!key) return;
  try {
    if (isR2Configured()) {
      await r2Service.deleteFile(key);
      return;
    }
    await fs.promises.unlink(localPath(key));
  } catch {
    // best-effort cleanup
  }
}

function importFileKey(importId, kind, ext) {
  return `imports/${importId}/${kind}.${ext}`;
}

module.exports = {
  isR2Configured,
  uploadBuffer,
  readBuffer,
  deleteObject,
  importFileKey,
};
