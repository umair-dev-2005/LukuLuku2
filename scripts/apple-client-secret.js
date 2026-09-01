#!/usr/bin/env node
// Generates an Apple "Sign In with Apple" client secret (JWT, ES256).
// Usage:
//   node scripts/apple-client-secret.js \
//     --p8 /path/to/AuthKey_XXXXXX.p8 \
//     --team-id  TEAMID1234 \
//     --key-id   KEYID12345 \
//     --client-id com.lukuluku.app
//
// Prints the JWT to stdout. Paste it into Lovable's "Client secret (JWT)" field.

const fs = require('fs');
const crypto = require('crypto');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const p8Path = arg('p8');
const teamId = arg('team-id');
const keyId = arg('key-id');
const clientId = arg('client-id');

if (!p8Path || !teamId || !keyId || !clientId) {
  console.error('Missing args. Need: --p8 --team-id --key-id --client-id');
  process.exit(1);
}

const privateKey = fs.readFileSync(p8Path, 'utf8');

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const now = Math.floor(Date.now() / 1000);
const header = { alg: 'ES256', kid: keyId };
const payload = {
  iss: teamId,
  iat: now,
  exp: now + 86400 * 180, // ~6 months (Apple max is 6 months)
  aud: 'https://appleid.apple.com',
  sub: clientId,
};

const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

// ES256 -> JOSE raw R||S signature (ieee-p1363), not DER.
const signature = crypto.sign('sha256', Buffer.from(signingInput), {
  key: privateKey,
  dsaEncoding: 'ieee-p1363',
});

const jwt = `${signingInput}.${b64url(signature)}`;

console.log('\n=== Apple Client Secret (JWT) ===');
console.log('Expires:', new Date(payload.exp * 1000).toISOString(), '(regenerate before this)');
console.log('\n' + jwt + '\n');
