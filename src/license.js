'use strict';
/**
 * Offline license-key verification for Leonidas of the Web Pro (Ed25519, SKS2 scheme).
 * Same scheme and public key as skill-shipper Pro and agent-guard Pro; distinct product id.
 *
 * Key format:  SKS2-<base64url(payload JSON)>.<base64url(64-byte Ed25519 signature)>
 * Payload:     {"d":"YYYY-MM-DD","eh":<email hash>,"oid":<order id>,"p":"leadwright-pro","v":2}
 *
 * Env: LEADWRIGHT_LICENSE_KEY
 * Dev: LEADWRIGHT_LICENSE_DEV=1 skips check (prints warning).
 */
const crypto = require('crypto');

const ENV_VAR = 'LEADWRIGHT_LICENSE_KEY';
const DEV_ENV_VAR = 'LEADWRIGHT_LICENSE_DEV';
const PRODUCT = 'leadwright-pro';
const PREFIX = 'SKS2-';
const PUBLIC_KEY_HEX = '3dbbb56b1323d05f19a12b5a62cef225cd915388e68922c06698b0f1f327af8e';
const REVOKED_ORDER_IDS = new Set();

function b64urlDecode(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function emailHash(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 16);
}

function ed25519Verify(pub, msg, sig) {
  try {
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]);
    return crypto.verify(null, msg, crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }), sig);
  } catch {
    return false;
  }
}

function decode(key, publicKeyHex) {
  if (!key) return null;
  key = String(key).replace(/\s+/g, '');
  if (!key.startsWith(PREFIX) || (key.match(/\./g) || []).length !== 1) return null;
  const body = key.slice(PREFIX.length);
  const dot = body.indexOf('.');
  const payloadB64 = body.slice(0, dot);
  const sigB64 = body.slice(dot + 1);
  let msg, sigb, pub;
  try {
    msg = b64urlDecode(payloadB64);
    sigb = b64urlDecode(sigB64);
    pub = Buffer.from(publicKeyHex || PUBLIC_KEY_HEX, 'hex');
  } catch {
    return null;
  }
  if (!ed25519Verify(pub, msg, sigb)) return null;
  let payload;
  try {
    payload = JSON.parse(msg.toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.p !== PRODUCT) return null;
  if (REVOKED_ORDER_IDS.has(payload.oid)) return null;
  return payload;
}

function validate(key, publicKeyHex) {
  return decode(key, publicKeyHex) != null;
}

function hasProLicense(key) {
  key = key || process.env.LEONIDAS_LICENSE_KEY || process.env[ENV_VAR];
  if (validate(key)) return true;
  if (process.env[DEV_ENV_VAR] === '1') return true;
  return false;
}

function requirePro(key) {
  key = key || process.env.LEONIDAS_LICENSE_KEY || process.env[ENV_VAR];
  if (validate(key)) return String(key).replace(/\s+/g, '');
  if (process.env[DEV_ENV_VAR] === '1') {
    console.error(`Leonidas Pro: ${DEV_ENV_VAR}=1, license check skipped (dev/test only).`);
    return key || 'DEV';
  }
  const err = new Error(
    `Leonidas Pro: no valid license key. Set ${ENV_VAR} to the key from your purchase email.\n` +
    `  bash: export ${ENV_VAR}='SKS2-....'\n` +
    'Launch price: $11 one-time (will rise later). Free core needs no key.'
  );
  err.code = 'LEADWRIGHT_LICENSE';
  throw err;
}

module.exports = {
  ENV_VAR,
  DEV_ENV_VAR,
  PRODUCT,
  PREFIX,
  PUBLIC_KEY_HEX,
  emailHash,
  decode,
  validate,
  hasProLicense,
  requirePro,
};
