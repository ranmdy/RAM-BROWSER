#!/usr/bin/env node
'use strict';

/**
 * Generate placeholder PNG icons for Ram Browser.
 *
 * Creates a simple purple gradient icon in the required sizes.
 * No external dependencies — uses Node.js built-in zlib only.
 *
 * Usage: node scripts/generate-icons.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ICONS_DIR = path.join(__dirname, '..', 'build', 'icons');

// ── Minimal PNG encoder ──────────────────────────────────────────────────────

function crc32(buf) {
  let crc = 0xffffffff;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })());
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Generate a minimal RGB PNG of the given size.
 * Draws a simple purple shield placeholder.
 */
function generatePng(size) {
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR: width, height, bit depth 8, color type 2 (RGB), interlace 0
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Build raw image data (unfiltered rows)
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.45;

  const rawRows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.allocUnsafe(1 + size * 3); // filter byte + RGB pixels
    row[0] = 0; // None filter
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const off = 1 + x * 3;

      if (dist > r) {
        // Transparent-ish dark outside
        row[off] = 20; row[off + 1] = 10; row[off + 2] = 40;
      } else {
        // Purple gradient based on distance and y position
        const t = dist / r;
        const shade = Math.max(0, 1 - t * 0.4);
        const gY = 1 - (y / size) * 0.3;
        row[off]     = Math.round(109 * shade * gY);  // R: 6d
        row[off + 1] = Math.round(40  * shade * gY);  // G: 28
        row[off + 2] = Math.round(217 * shade * gY);  // B: d9
      }
    }
    rawRows.push(row);
  }

  const rawData = Buffer.concat(rawRows);
  const compressed = zlib.deflateSync(rawData, { level: 9 });

  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ── Generate icons ───────────────────────────────────────────────────────────

fs.mkdirSync(ICONS_DIR, { recursive: true });

const sizes = [16, 32, 48, 64, 128, 256, 512];
for (const size of sizes) {
  const png = generatePng(size);
  const outPath = path.join(ICONS_DIR, `${size}x${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Generated ${outPath} (${png.length} bytes)`);
}

// Also write the main icon.png (512px) for electron-builder
fs.writeFileSync(path.join(ICONS_DIR, 'icon.png'), generatePng(512));
console.log('Generated build/icons/icon.png');

// Note: .icns and .ico require platform-specific tools (iconutil / magick)
// electron-builder will use icon.png as fallback on all platforms
console.log('\nNote: For production, generate icon.icns (macOS) and icon.ico (Windows)');
console.log('See build/icons/README.md for instructions.');
