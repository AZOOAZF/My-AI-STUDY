const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('email templates do not expose secrets', () => {
  const text = fs.readFileSync(path.join(__dirname, 'email-templates.js'), 'utf8');
  assert.equal(text.includes('RESEND_API_KEY'), false);
  assert.equal(text.includes('STRIPE_SECRET_KEY'), false);
});

test('data file has no payment secrets', () => {
  const text = fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8');
  assert.equal(/sk_(test|live)_|whsec_|re_[A-Za-z0-9]/.test(text), false);
});
