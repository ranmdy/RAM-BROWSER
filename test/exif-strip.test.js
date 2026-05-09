'use strict';

/**
 * exif-strip.test.js
 *
 * Tests for the pure-Node PNG EXIF/metadata stripper.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { stripPngMetadata, stripDataUrlMetadata } = require('../src/main/security/exif-strip');

// Minimal valid 1×1 PNG (white pixel, no metadata)
const MINIMAL_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Helper: build a fake PNG chunk
function makeChunk(type, data = Buffer.alloc(0)) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);
  // Fake CRC (4 bytes zeros — valid enough for our parser which doesn't validate CRC)
  const crc = Buffer.alloc(4);
  return Buffer.concat([lenBuf, typeBuf, data, crc]);
}

function makePng(chunks) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, ...chunks]);
}

describe('EXIF strip — PNG metadata removal', () => {
  it('leaves a minimal valid PNG unchanged', () => {
    const input = Buffer.from(MINIMAL_PNG_B64, 'base64');
    const output = stripPngMetadata(input);
    // Should return same content (minimal PNG has no metadata chunks)
    assert.ok(output.length <= input.length, 'output should not be larger');
    // PNG signature preserved
    assert.equal(output[1], 0x50); // 'P'
    assert.equal(output[2], 0x4e); // 'N'
    assert.equal(output[3], 0x47); // 'G'
  });

  it('strips tEXt chunks', () => {
    const ihdr = makeChunk('IHDR', Buffer.alloc(13));
    const text = makeChunk('tEXt', Buffer.from('Author\x00Test User'));
    const iend = makeChunk('IEND');
    const png = makePng([ihdr, text, iend]);

    const result = stripPngMetadata(png);
    assert.ok(!result.includes(Buffer.from('tEXt', 'ascii')), 'tEXt chunk should be removed');
    assert.ok(result.includes(Buffer.from('IHDR', 'ascii')), 'IHDR chunk preserved');
    assert.ok(result.includes(Buffer.from('IEND', 'ascii')), 'IEND chunk preserved');
  });

  it('strips eXIf chunks', () => {
    const ihdr = makeChunk('IHDR', Buffer.alloc(13));
    const exif = makeChunk('eXIf', Buffer.from('EXIF\x00\x00fake-exif-data'));
    const iend = makeChunk('IEND');
    const png = makePng([ihdr, exif, iend]);

    const result = stripPngMetadata(png);
    assert.ok(!result.includes(Buffer.from('eXIf', 'ascii')), 'eXIf chunk should be removed');
  });

  it('strips iTXt chunks', () => {
    const ihdr = makeChunk('IHDR', Buffer.alloc(13));
    const itxt = makeChunk('iTXt', Buffer.from('Comment\x00\x00\x00\x00\x00GPS data here'));
    const iend = makeChunk('IEND');
    const png = makePng([ihdr, itxt, iend]);

    const result = stripPngMetadata(png);
    assert.ok(!result.includes(Buffer.from('iTXt', 'ascii')), 'iTXt chunk should be removed');
  });

  it('strips tIME (timestamp) chunks', () => {
    const ihdr = makeChunk('IHDR', Buffer.alloc(13));
    const time = makeChunk('tIME', Buffer.alloc(7)); // tIME is always 7 bytes
    const iend = makeChunk('IEND');
    const png = makePng([ihdr, time, iend]);

    const result = stripPngMetadata(png);
    assert.ok(!result.includes(Buffer.from('tIME', 'ascii')), 'tIME chunk should be removed');
  });

  it('preserves IHDR, IDAT, IEND, PLTE chunks', () => {
    const ihdr = makeChunk('IHDR', Buffer.alloc(13));
    const idat = makeChunk('IDAT', Buffer.from([0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]));
    const iend = makeChunk('IEND');
    const png = makePng([ihdr, idat, iend]);

    const result = stripPngMetadata(png);
    assert.ok(result.includes(Buffer.from('IHDR', 'ascii')), 'IHDR preserved');
    assert.ok(result.includes(Buffer.from('IDAT', 'ascii')), 'IDAT preserved');
    assert.ok(result.includes(Buffer.from('IEND', 'ascii')), 'IEND preserved');
  });

  it('returns non-PNG data unchanged', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    assert.equal(stripPngMetadata(jpeg), jpeg);

    const empty = Buffer.alloc(0);
    assert.equal(stripPngMetadata(empty), empty);
  });

  it('stripDataUrlMetadata handles PNG data URLs', () => {
    const dataUrl = `data:image/png;base64,${MINIMAL_PNG_B64}`;
    const result = stripDataUrlMetadata(dataUrl);
    assert.ok(result.startsWith('data:image/png;base64,'), 'preserves data URL format');
    assert.ok(result.length > 0, 'non-empty result');
  });

  it('stripDataUrlMetadata passes through non-PNG data URLs unchanged', () => {
    const jpegUrl = 'data:image/jpeg;base64,/9j/4AAQ...';
    assert.equal(stripDataUrlMetadata(jpegUrl), jpegUrl);

    const nonUrl = 'https://example.com/image.png';
    assert.equal(stripDataUrlMetadata(nonUrl), nonUrl);
  });

  it('handles multiple metadata chunks in sequence', () => {
    const ihdr = makeChunk('IHDR', Buffer.alloc(13));
    const text1 = makeChunk('tEXt', Buffer.from('Author\x00Alice'));
    const text2 = makeChunk('tEXt', Buffer.from('Software\x00RamBrowser'));
    const exif = makeChunk('eXIf', Buffer.alloc(32));
    const time = makeChunk('tIME', Buffer.alloc(7));
    const idat = makeChunk('IDAT', Buffer.alloc(10));
    const iend = makeChunk('IEND');
    const png = makePng([ihdr, text1, text2, exif, time, idat, iend]);

    const result = stripPngMetadata(png);
    const resultStr = result.toString('binary');
    assert.ok(!result.includes(Buffer.from('tEXt', 'ascii')), 'all tEXt removed');
    assert.ok(!result.includes(Buffer.from('eXIf', 'ascii')), 'eXIf removed');
    assert.ok(!result.includes(Buffer.from('tIME', 'ascii')), 'tIME removed');
    assert.ok(result.includes(Buffer.from('IDAT', 'ascii')), 'IDAT preserved');
    assert.ok(result.includes(Buffer.from('IEND', 'ascii')), 'IEND preserved');
  });
});
