// src/api/SalesforceAuth.js
//
// Performs the OAuth 2.0 JWT Bearer flow once, at the start of the run
// (called from global-setup.js). This is the only place a credential is
// ever exchanged with Salesforce — individual tests never see the private
// key. Replaces the username-password flow, which this org rejects
// outright: it's incompatible with the org's MFA enforcement and is not
// supported at all on the External Client App model.
const { request } = require('@playwright/test');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

function buildAssertion() {
  // Standard JWT Bearer claims Salesforce expects: iss = Connected App
  // Consumer Key, sub = the Salesforce username being authenticated as,
  // aud = the login host, exp = a short lifetime (the assertion is used
  // once, immediately).
  return jwt.sign({}, env.jwtPrivateKey, {
    algorithm: 'RS256',
    issuer: env.consumerKey,
    subject: env.username,
    audience: env.loginUrl,
    expiresIn: '3m',
  });
}

async function authenticate() {
  // A standalone Playwright request context (no browser page needed) just
  // to hit the token endpoint.
  const context = await request.newContext();
  const response = await context.post(`${env.loginUrl}/services/oauth2/token`, {
    form: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildAssertion(),
    },
  });

  if (!response.ok()) {
    // Fail fast with the response body — auth failures here would otherwise
    // surface as a confusing downstream 401 on the first API call.
    throw new Error(`Salesforce auth failed: ${response.status()} ${await response.text()}`);
  }

  const body = await response.json();
  await context.dispose(); // release the request context now that the token has been read
  return { accessToken: body.access_token, instanceUrl: body.instance_url };
}

module.exports = { authenticate };
