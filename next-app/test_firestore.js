import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import crypto from 'crypto';
import https from 'https';
const key = require('C:/Users/Admin/Downloads/automated-identity-vault-firebase-adminsdk-fbsvc-e9a6f27b9a.json');

const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const payload = Buffer.from(JSON.stringify({
  iss: key.client_email,
  sub: key.client_email,
  aud: 'https://oauth2.googleapis.com/token',
  iat: now,
  exp: now + 3600,
  scope: 'https://www.googleapis.com/auth/datastore'
})).toString('base64url');
const sig = crypto.sign('sha256', Buffer.from(header + '.' + payload), key.private_key).toString('base64url');
const jwt = header + '.' + payload + '.' + sig;
const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt;

console.log('Requesting access token...');
const req = https.request(
  { hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
  (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      console.log('Token HTTP status:', res.statusCode);
      let tok;
      try { tok = JSON.parse(d); } catch { console.log('Parse fail:', d.substring(0, 300)); return; }
      if (!tok.access_token) { console.log('TOKEN FAIL:', JSON.stringify(tok).substring(0, 300)); return; }
      console.log('Access token OK! Querying Firestore REST...');

      const fr = https.request(
        {
          hostname: 'firestore.googleapis.com',
          path: '/v1/projects/automated-identity-vault/databases/(default)/documents/vaults',
          headers: { 'Authorization': 'Bearer ' + tok.access_token }
        },
        (r) => {
          let fd = '';
          r.on('data', c => fd += c);
          r.on('end', () => {
            console.log('Firestore REST HTTP status:', r.statusCode);
            console.log('Response:', fd.substring(0, 1000));
          });
        }
      );
      fr.on('error', e => console.log('Firestore error:', e.message));
      fr.end();
    });
  }
);
req.on('error', e => console.log('OAuth error:', e.message));
req.write(body);
req.end();
