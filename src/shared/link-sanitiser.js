const TRACKING_PARAMS = new Set([
  // Google / DoubleClick
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  // Microsoft
  'msclkid',
  // Twitter / X
  'twclid',
  // Instagram
  'igshid',
  // Mailchimp
  'mc_cid',
  'mc_eid',
  // Marketo
  'mkt_tok',
  // Vero
  'vero_id',
  'vero_conv',
  // Yandex
  'yclid',
  // HubSpot
  '_hsenc',
  '_hsmi',
  '__hstc',
  '__hssc',
  '__hsfp',
  // Alibaba
  'spm',
  // Omeda
  'oly_enc_id',
  'oly_anon_id',
  // Generic referral
  'ref',
  'referrer',
  'referer',
  'ref_src',
  'ref_url'
]);

const REDIRECT_PARAMS = ['url', 'u', 'q', 'target', 'redirect_url', 'redirect'];

function isHttpUrl(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function isTrackingParam(name) {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

function extractRedirectTarget(url) {
  const hostname = url.hostname.replace(/^www\./, '');
  const redirectHosts = new Set([
    'facebook.com',
    'l.facebook.com',
    'lm.facebook.com',
    'google.com',
    'duckduckgo.com',
    'linkedin.com'
  ]);

  if (!redirectHosts.has(hostname)) {
    return null;
  }

  for (const param of REDIRECT_PARAMS) {
    const value = url.searchParams.get(param);
    if (!value) continue;

    try {
      const target = new URL(value);
      if (isHttpUrl(target)) return target.toString();
    } catch {
      continue;
    }
  }

  return null;
}

function sanitiseUrl(rawUrl) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  if (!isHttpUrl(url)) {
    return rawUrl;
  }

  const redirectTarget = extractRedirectTarget(url);
  if (redirectTarget) {
    return sanitiseUrl(redirectTarget);
  }

  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingParam(key)) {
      url.searchParams.delete(key);
    }
  }

  return url.toString();
}

function isLocalAddress(rawUrl) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '::1'
  ) {
    return true;
  }

  if (host.startsWith('127.')) return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;

  const parts = host.split('.').map(Number);
  if (parts.length === 4 && parts.every(Number.isInteger)) {
    return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
  }

  return false;
}

module.exports = {
  sanitiseUrl,
  isLocalAddress,
  isTrackingParam
};
