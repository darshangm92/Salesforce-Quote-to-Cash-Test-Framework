// scripts/generate-jwt-cert.js
//
// One-time (and re-run-on-expiry) generator for the RSA key pair and
// self-signed certificate used by the JWT Bearer Flow (src/api/SalesforceAuth.js).
// Output goes to .certs/, which is gitignored — server.crt (public) is uploaded
// to the Connected App's "Use digital signatures" setting in Salesforce Setup;
// server.key (private) never leaves this machine / the CI secret store.
//
// Usage: node scripts/generate-jwt-cert.js
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');

const OUT_DIR = path.join(__dirname, '..', '.certs');
const VALID_DAYS = 730;

function generate() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + VALID_DAYS);

  const attrs = [{ name: 'commonName', value: 'SF-CPQ-Playwright' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);

  fs.writeFileSync(path.join(OUT_DIR, 'server.key'), keyPem);
  fs.writeFileSync(path.join(OUT_DIR, 'server.crt'), certPem);

  console.log(`Generated ${VALID_DAYS}-day key pair in ${OUT_DIR}`);
  console.log('  server.key — private, never commit, used by SalesforceAuth.js / CI secret');
  console.log('  server.crt — public, upload to the Connected App (Use digital signatures)');
}

generate();
