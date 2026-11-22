'use strict';
/**
 * Cheap address checks that run before any mail is queued.
 *
 * junkReason(email): addresses a scraper picks up that are never a real person: image and asset
 * file names (vapes@72x-copy.avif), template placeholders (john.doe@..., nombre@correo.com,
 * example@gmail.com), tracking/platform addresses, and malformed ones. Sync, no network.
 *
 * mailDomainStatus(domain): whether the domain can receive mail at all (an MX record, or an A/AAAA
 * record as the implicit MX). A domain with neither bounces every message. Async, uses DNS.
 */
const dns = require('dns').promises;

const ASSET_TLD = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|tiff?|js|mjs|css|map|json|xml|pdf|woff2?|ttf|eot|mp4|webm|php|html?)$/i;
const PLACEHOLDER_LOCAL = /^(john\.?doe|jane\.?doe|johndoe|janedoe|example|sample|test|testing|nombre|correo|your\.?name|yourname|your\.?email|youremail|name|first\.?last|firstname|user(name)?|email|someone|somebody|me|you|abc|xyz|asdf|foo|bar|noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster)$/i;
const PLACEHOLDER_DOMAIN = /(^|\.)(example\.(com|org|net)|domain\.(com|net|org)|yourdomain\.\w+|your-domain\.\w+|email\.com|correo\.com|mystore\.com|mycompany\.com|company\.com|website\.com|yoursite\.\w+|test\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|mytemp\.website|godaddysites\.com)$/i;
const IMAGE_SIZE = /(^|[-_.])\d+x(\d+)?([-_.]|$)|@\dx\b/i;

function junkReason(email) {
  const e = String(email || '').trim().toLowerCase();
  const m = e.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!m) return 'not an email address';
  const [, local, domain] = m;
  if (/^[^a-z0-9]|[^a-z0-9]$/.test(local)) return 'address starts or ends with punctuation (likely scraped from text)';
  if (/\.\./.test(local) || /\.\./.test(domain)) return 'address has two dots in a row';
  if (ASSET_TLD.test(domain)) return 'looks like a file name (image or web asset), not an email address';
  if (IMAGE_SIZE.test(domain)) return 'looks like an image file name, not an email address';
  const tld = domain.split('.').pop();
  if (!domain.includes('.') || !/^[a-z]{2,24}$|^xn--[a-z0-9-]+$/.test(tld)) return `domain "${domain}" has no valid top-level domain`;
  // ".com" run into the next word on the page ("x.comconnect"), not real TLDs like .community or .network.
  if (/^(com|net|org)(?!munity|pany|puter|work|ganic)[a-z]{3,}$/.test(tld)) return `domain "${domain}" looks run together with the text after it`;
  if (PLACEHOLDER_DOMAIN.test(domain)) return `placeholder or platform domain "${domain}"`;
  if (PLACEHOLDER_LOCAL.test(local)) return `placeholder address "${local}@"`;
  return null;
}

/** 'ok' | 'no_mail_server' | 'unknown' (DNS error other than "does not exist"). */
async function mailDomainStatus(domain, { resolver = dns } = {}) {
  const missing = e => e && ['ENOTFOUND', 'ENODATA', 'ENONAME'].includes(e.code);
  try {
    const mx = await resolver.resolveMx(domain);
    // RFC 7505 null MX ("0 .") means the domain accepts no mail.
    if (mx.length && mx.every(r => !r.exchange || r.exchange === '.')) return 'no_mail_server';
    if (mx.length) return 'ok';
  } catch (e) { if (!missing(e)) return 'unknown'; }
  for (const fn of ['resolve4', 'resolve6']) {
    try { if ((await resolver[fn](domain)).length) return 'ok'; } catch (e) { if (!missing(e)) return 'unknown'; }
  }
  return 'no_mail_server';
}

module.exports = { junkReason, mailDomainStatus };
