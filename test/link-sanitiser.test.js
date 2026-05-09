const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitiseUrl, isLocalAddress, isTrackingParam } = require('../src/shared/link-sanitiser');

test('removes common tracking parameters while preserving useful parameters', () => {
  const result = sanitiseUrl('https://example.com/read?id=42&utm_source=newsletter&fbclid=abc');
  assert.equal(result, 'https://example.com/read?id=42');
});

test('unwraps known redirect links', () => {
  const result = sanitiseUrl('https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fpage%3Futm_medium%3Dx%26id%3D7');
  assert.equal(result, 'https://example.com/page?id=7');
});

test('leaves non-http protocols untouched', () => {
  assert.equal(sanitiseUrl('file:///tmp/test.html?utm_source=x'), 'file:///tmp/test.html?utm_source=x');
});

test('detects local addresses for kill-switch bypass', () => {
  assert.equal(isLocalAddress('http://localhost:3000'), true);
  assert.equal(isLocalAddress('http://192.168.1.10'), true);
  assert.equal(isLocalAddress('http://172.20.0.4'), true);
  assert.equal(isLocalAddress('https://example.com'), false);
});

test('recognizes utm-prefixed tracking keys', () => {
  assert.equal(isTrackingParam('utm_campaign'), true);
  assert.equal(isTrackingParam('id'), false);
});
