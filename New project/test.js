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
  const text = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8') + fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.match(text, /获取验证码/);
  assert.match(text, /注册并继续/);
  assert.equal(text.includes('管理员入口'), false);
  assert.equal(text.includes('演示验证码：123456'), false);
});

test('new users must complete a learning profile', () => {
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8') + fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
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
});

test('password login and setup are implemented without exposing password hashes', () => {
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.match(server, /api\/auth\/password-login/);
  assert.match(server, /api\/auth\/password/);
  assert.match(server, /crypto\.scryptSync/);
  assert.match(server, /publicUser/);
  assert.match(app, /设置登录密码/);
  assert.match(app, /密码登录/);
  assert.equal(app.includes('passwordHash'), false);
});

test('check-ins use a 56-day table instead of calendar dates', () => {
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const storage = fs.readFileSync(path.join(__dirname, 'storage.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.match(server, /day:i\+1/);
  assert.match(server, /打卡日必须是第 1-56 天/);
  assert.match(storage, /day: index \+ 1/);
  assert.match(app, /56 天打卡表/);
  assert.match(app, /第 ' \+ task\.day \+ ' 天/);
});

test('onboarding uses compact selectable options', () => {
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.match(app, /学习目标（可多选）/);
  assert.match(app, /checkGroup\('goal'/);
  assert.match(app, /selectField\('国家或地区'/);
  assert.equal(app.includes('个人网站'), false);
});
