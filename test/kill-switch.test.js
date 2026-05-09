'use strict';

/**
 * Kill-switch invariant tests.
 *
 * These tests verify that the request interceptor in configureSession() behaves
 * correctly:
 *   - When RAM_REQUIRE_VPN=1 and no proxy URL: remote network requests are cancelled
 *   - Local addresses are always allowed
 *   - Tracking params are stripped via redirect
 *   - Finance container third-party scripts are blocked
 *
 * We test the interceptor logic directly without Electron.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// ── Helpers ───────────────────────────────────────────────────────────────────

const { sanitiseUrl, isLocalAddress, isTrackingParam } = require('../src/shared/link-sanitiser');

function isNetworkRequest(url) {
  try {
    const { protocol } = new URL(url);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(protocol);
  } catch {
    return false;
  }
}

/**
 * Simulates the webRequest.onBeforeRequest logic from index.js (without Electron).
 * @param {object} opts
 * @param {boolean} opts.requireWarp
 * @param {boolean} opts.hasProxy
 * @param {boolean} opts.isFinance
 * @param {string} opts.url
 * @param {string} [opts.referrer]
 * @returns {'cancel'|'redirect'|'allow'} and redirectURL if redirect
 */
function simulateInterceptor({ requireWarp, hasProxy, isFinance, url, referrer = '' }) {
  // Kill switch
  if (requireWarp && !hasProxy && isNetworkRequest(url) && !isLocalAddress(url)) {
    return { action: 'cancel' };
  }

  // Finance container: block third-party scripts
  if (isFinance) {
    try {
      if (/\.js(\?|$)/i.test(url)) {
        const reqHost = new URL(url).hostname;
        const refHost = referrer ? new URL(referrer).hostname : reqHost;
        const baseDomain = (h) => h.split('.').slice(-2).join('.');
        if (baseDomain(reqHost) !== baseDomain(refHost)) {
          return { action: 'cancel' };
        }
      }
    } catch { /* not a valid URL, allow */ }
  }

  // Link sanitiser
  const cleanedUrl = sanitiseUrl(url);
  let normalizedOriginal;
  try { normalizedOriginal = new URL(url).href; } catch { normalizedOriginal = url; }
  if (cleanedUrl !== normalizedOriginal) {
    return { action: 'redirect', redirectURL: cleanedUrl };
  }

  return { action: 'allow' };
}

// ── Kill switch tests ─────────────────────────────────────────────────────────

describe('Kill switch (RAM_REQUIRE_VPN=1, no proxy)', () => {
  it('cancels remote HTTP requests', () => {
    const result = simulateInterceptor({
      requireWarp: true, hasProxy: false, isFinance: false,
      url: 'https://example.com/page'
    });
    assert.equal(result.action, 'cancel');
  });

  it('cancels remote HTTPS requests', () => {
    const result = simulateInterceptor({
      requireWarp: true, hasProxy: false, isFinance: false,
      url: 'https://tracker.example/pixel.gif'
    });
    assert.equal(result.action, 'cancel');
  });

  it('allows local loopback even with kill switch on', () => {
    const result = simulateInterceptor({
      requireWarp: true, hasProxy: false, isFinance: false,
      url: 'http://localhost:3000/api'
    });
    assert.equal(result.action, 'allow');
  });

  it('allows 127.x.x.x even with kill switch on', () => {
    const result = simulateInterceptor({
      requireWarp: true, hasProxy: false, isFinance: false,
      url: 'http://127.0.0.1:8080/health'
    });
    assert.equal(result.action, 'allow');
  });

  it('allows *.local mDNS addresses even with kill switch on', () => {
    const result = simulateInterceptor({
      requireWarp: true, hasProxy: false, isFinance: false,
      url: 'http://office-wifi.local:5000/api'
    });
    assert.equal(result.action, 'allow');
  });

  it('does NOT cancel when proxy is configured', () => {
    const result = simulateInterceptor({
      requireWarp: true, hasProxy: true, isFinance: false,
      url: 'https://example.com/page'
    });
    assert.notEqual(result.action, 'cancel');
  });

  it('does NOT cancel when kill switch is off', () => {
    const result = simulateInterceptor({
      requireWarp: false, hasProxy: false, isFinance: false,
      url: 'https://example.com/page'
    });
    assert.notEqual(result.action, 'cancel');
  });
});

// ── Link sanitiser integration ────────────────────────────────────────────────

describe('Kill switch: link sanitiser integration', () => {
  it('redirects URLs with tracking params', () => {
    const result = simulateInterceptor({
      requireWarp: false, hasProxy: false, isFinance: false,
      url: 'https://example.com/?utm_source=email&article=123'
    });
    assert.equal(result.action, 'redirect');
    assert.ok(result.redirectURL.includes('article=123'));
    assert.ok(!result.redirectURL.includes('utm_source'));
  });

  it('allows clean URLs without modification', () => {
    const result = simulateInterceptor({
      requireWarp: false, hasProxy: false, isFinance: false,
      url: 'https://example.com/article?id=42'
    });
    assert.equal(result.action, 'allow');
  });

  it('strips fbclid and allows remaining params', () => {
    const result = simulateInterceptor({
      requireWarp: false, hasProxy: false, isFinance: false,
      url: 'https://shop.example.com/?fbclid=XYZ&product=shoes&color=red'
    });
    assert.equal(result.action, 'redirect');
    assert.ok(!result.redirectURL.includes('fbclid'));
    assert.ok(result.redirectURL.includes('product=shoes'));
    assert.ok(result.redirectURL.includes('color=red'));
  });
});

// ── Finance container hardening ───────────────────────────────────────────────

describe('Finance container hardening', () => {
  it('blocks third-party JS from a different domain', () => {
    const result = simulateInterceptor({
      requireWarp: false, hasProxy: false, isFinance: true,
      url: 'https://cdn.tracking.com/analytics.js',
      referrer: 'https://mybank.com/dashboard'
    });
    assert.equal(result.action, 'cancel');
  });

  it('allows first-party JS on the same domain', () => {
    const result = simulateInterceptor({
      requireWarp: false, hasProxy: false, isFinance: true,
      url: 'https://mybank.com/assets/app.js',
      referrer: 'https://mybank.com/dashboard'
    });
    assert.equal(result.action, 'allow');
  });

  it('allows first-party JS from a subdomain of the same base domain', () => {
    const result = simulateInterceptor({
      requireWarp: false, hasProxy: false, isFinance: true,
      url: 'https://static.mybank.com/app.js',
      referrer: 'https://mybank.com/dashboard'
    });
    assert.equal(result.action, 'allow');
  });

  it('allows non-JS resources in finance container (images, CSS, etc.)', () => {
    const result = simulateInterceptor({
      requireWarp: false, hasProxy: false, isFinance: true,
      url: 'https://cdn.tracking.com/logo.png',
      referrer: 'https://mybank.com/dashboard'
    });
    // Images are not blocked by the third-party JS rule
    assert.notEqual(result.action, 'cancel');
  });

  it('blocks third-party JS even with kill switch off', () => {
    const result = simulateInterceptor({
      requireWarp: false, hasProxy: true, isFinance: true,
      url: 'https://evil.tracker/track.js',
      referrer: 'https://mybank.com/'
    });
    assert.equal(result.action, 'cancel');
  });
});
