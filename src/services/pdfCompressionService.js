const { PDFDocument } = require('pdf-lib');
const logger = require('../lib/logger');

/**
 * Re-saves a PDF with object streams to reduce size before upload to R2.
 * On failure, returns the original buffer unchanged.
 *
 * @param {Buffer} inputBuffer
 * @returns {Promise<{ buffer: Buffer, originalBytes: number, compressedBytes: number, compressed: boolean }>}
 */
async function compressPdfBuffer(inputBuffer) {
  const originalBytes = inputBuffer?.length ?? 0;

  if (!inputBuffer || originalBytes === 0) {
    return {
      buffer: inputBuffer || Buffer.alloc(0),
      originalBytes,
      compressedBytes: originalBytes,
      compressed: false,
    };
  }

  try {
    const pdfDoc = await PDFDocument.load(inputBuffer, { ignoreEncryption: true });
    const saved = await pdfDoc.save({ useObjectStreams: true });
    const buffer = Buffer.from(saved);
    const compressedBytes = buffer.length;
    const reductionPercent =
      originalBytes > 0 ? Math.round((1 - compressedBytes / originalBytes) * 100) : 0;

    logger.info(
      { originalBytes, compressedBytes, reductionPercent },
      'menu PDF compression'
    );

    return {
      buffer,
      originalBytes,
      compressedBytes,
      compressed: true,
    };
  } catch (err) {
    logger.warn(
      { err: err.message, originalBytes },
      'menu PDF compression failed, using original buffer'
    );
    return {
      buffer: inputBuffer,
      originalBytes,
      compressedBytes: originalBytes,
      compressed: false,
    };
  }
}

module.exports = {
  compressPdfBuffer,
};
