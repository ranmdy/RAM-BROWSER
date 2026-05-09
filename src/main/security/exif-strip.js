'use strict';

/**
 * exif-strip.js — Pure Node.js PNG metadata strip.
 *
 * Removes EXIF and other metadata chunks from PNG files without requiring
 * any external dependencies (no sharp, no piexifjs).
 *
 * PNG chunk layout: [4-byte length][4-byte type][data][4-byte CRC]
 * We strip the following ancillary chunks that can carry identifying metadata:
 *   - eXIf  EXIF metadata
 *   - tEXt  Latin-1 text key/value pairs
 *   - zTXt  Compressed text key/value pairs
 *   - iTXt  UTF-8 text key/value pairs (may contain GPS, author, etc.)
 *   - tIME  Image creation timestamp
 *   - iCCP  ICC colour profile (may embed software name)
 *
 * Critical chunks (IHDR, IDAT, IEND, PLTE) are always preserved.
 *
 * @param {Buffer} pngData  Raw PNG file bytes
 * @returns {Buffer}  PNG bytes with metadata chunks removed
 */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Chunk types to strip (4 ASCII bytes, case-sensitive per PNG spec)
const STRIP_TYPES = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME', 'iCCP']);

/**
 * Strip metadata chunks from a PNG Buffer.
 * Non-PNG input is returned unchanged.
 * @param {Buffer} pngData
 * @returns {Buffer}
 */
function stripPngMetadata(pngData) {
  if (!Buffer.isBuffer(pngData) || pngData.length < 8) return pngData;

  // Verify PNG signature
  if (!pngData.subarray(0, 8).equals(PNG_SIG)) return pngData;

  const chunks = [];
  let offset = 8; // skip signature

  while (offset < pngData.length) {
    if (offset + 8 > pngData.length) break; // not enough bytes for header

    const dataLength = pngData.readUInt32BE(offset);
    const chunkType = pngData.subarray(offset + 4, offset + 8).toString('ascii');
    const totalChunkSize = 4 + 4 + dataLength + 4; // length + type + data + CRC

    if (offset + totalChunkSize > pngData.length) break; // malformed chunk

    if (!STRIP_TYPES.has(chunkType)) {
      chunks.push(pngData.subarray(offset, offset + totalChunkSize));
    }

    offset += totalChunkSize;
  }

  return Buffer.concat([PNG_SIG, ...chunks]);
}

/**
 * Strip metadata from a PNG data URL.
 * Non-PNG data URLs are returned unchanged.
 * @param {string} dataUrl  e.g. 'data:image/png;base64,...'
 * @returns {string}  data URL with metadata stripped
 */
function stripDataUrlMetadata(dataUrl) {
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) return dataUrl;

  try {
    const base64 = dataUrl.slice('data:image/png;base64,'.length);
    const pngData = Buffer.from(base64, 'base64');
    const stripped = stripPngMetadata(pngData);
    return 'data:image/png;base64,' + stripped.toString('base64');
  } catch {
    return dataUrl; // return original if stripping fails
  }
}

module.exports = { stripPngMetadata, stripDataUrlMetadata };
