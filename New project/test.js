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

test('login UI has email registration without an admin entry', () => {
  const text = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(text, /获取验证码/);
  assert.match(text, /注册并继续/);
  assert.equal(text.includes('管理员入口'), false);
  assert.equal(text.includes('演示验证码：123456'), false);
});

test('new users must complete a learning profile', () => {
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(server, /profileCompleted:false/);
  assert.match(server, /purpose==='register'&&d\.users\[email\]/);
  assert.match(page, /先创建你的学习档案/);
  assert.match(page, /experienceLevel/);
});

test('QQ SMTP is supported without committing credentials', () => {
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const env = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
  assert.match(server, /nodemailer\.createTransport/);
  assert.match(env, /SMTP_HOST=smtp\.qq\.com/);
  assert.match(env, /SMTP_PASS=your-qq-mail-authorization-code/);
  assert.doesNotMatch(server, /utceknkrghduecag/);
  assert.doesNotMatch(env, /utceknkrghduecag/);
});
