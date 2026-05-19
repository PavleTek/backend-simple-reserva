const { PDFDocument } = require('pdf-lib');

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Compress a PDF buffer using pdf-lib.
 * Reloads and re-saves the document with stream compression enabled.
 * Falls back to the original buffer if compression fails or produces a
 * larger result.
 *
 * @param {Buffer} inputBuffer - Original PDF file buffer
 * @returns {Promise<{ buffer: Buffer, originalSize: number, compressedSize: number, ratio: number }>}
 */
async function compressPdf(inputBuffer) {
  const originalSize = inputBuffer.length;

  try {
    const pdfDoc = await PDFDocument.load(inputBuffer, {
      // Ignore minor spec violations common in real-world PDFs
      ignoreEncryption: false,
      updateMetadata: false,
    });

    const compressedBytes = await pdfDoc.save({
      useObjectStreams: true,   // Pack multiple objects into compressed streams
      addDefaultPage: false,
      objectsPerTick: 50,
    });

    const compressedBuffer = Buffer.from(compressedBytes);
    const compressedSize = compressedBuffer.length;

    // Only use the compressed version if it is actually smaller
    if (compressedSize < originalSize) {
      const ratio = ((originalSize - compressedSize) / originalSize) * 100;
      return { buffer: compressedBuffer, originalSize, compressedSize, ratio };
    }

    // Compression made it larger (already optimised PDF) — return original
    return { buffer: inputBuffer, originalSize, compressedSize: originalSize, ratio: 0 };
  } catch (err) {
    // Graceful fallback: log the error and return the original buffer unchanged
    console.error('[pdfCompressionService] Compression failed, using original buffer:', err.message);
    return { buffer: inputBuffer, originalSize, compressedSize: originalSize, ratio: 0 };
  }
}

/**
 * Returns true when the buffer exceeds the 50 MB hard limit.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function exceedsMaxSize(buffer) {
  return buffer.length > MAX_FILE_SIZE;
}

module.exports = { compressPdf, exceedsMaxSize, MAX_FILE_SIZE };
