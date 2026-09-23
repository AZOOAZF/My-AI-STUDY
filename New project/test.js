const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('node:child_process');

function withServer(run) {
  const { app } = require('./server');
  const server = http.createServer((req, res) => app(req, res).catch(error => {
    res.statusCode = error.statusCode || 500;
    res.end(JSON.stringify({ error: error.message }));
  }));
  return new Promise((resolve, reject) => server.listen(0, async () => {
    try { resolve(await run('http://127.0.0.1:' + server.address().port)); }
    catch (error) { reject(error); }
    finally { server.close(); }
  }));
}

test('email templates do not expose secrets', () => {
  const text = fs.readFileSync(path.join(__dirname, 'email-templates.js'), 'utf8');
  assert.equal(text.includes('RESEND_API_KEY'), false);
  assert.equal(text.includes('STRIPE_SECRET_KEY'), false);
});

test('data file has no payment secrets', () => {
  const text = fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8');
  assert.equal(/sk_(test|live)_|whsec_|re_[A-Za-z0-9]/.test(text), false);
});

test('production refuses to use ephemeral profile storage', () => {
  const script = "delete process.env.SUPABASE_URL;delete process.env.SUPABASE_SECRET_KEY;delete process.env.SUPABASE_SERVICE_ROLE_KEY;process.env.VERCEL_ENV='production';require('./storage').load(()=>[]).then(()=>process.exit(1)).catch(error=>{if(error.statusCode!==503)process.exit(2);console.log(error.message)})";
  const result = spawnSync(process.execPath, ['-e', script], { cwd: __dirname, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /持久化数据库/);
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

test('admin console is available only through a direct path', () => {
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.match(server, /u\.pathname==='\/admin'/);
  assert.match(app, /location\.pathname === '\/admin'/);
  assert.match(app, /管理员登录/);
});

test('admin session keeps its role even if the email is also a user', () => {
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(server, /me\.role==='admin'\?me:publicUser/);
});

test('admin login fails closed without explicit credentials', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'admin123' })
    });
    assert.equal(response.status, 503);
  });
});

test('oversized JSON requests are rejected', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/api/auth/request-code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a'.repeat(70000) + '@example.com' })
    });
    assert.equal(response.status, 413);
  });
});

test('long-lived login uses a revocable refresh token', () => {
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const storage = fs.readFileSync(path.join(__dirname, 'storage.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.match(server, /api\/auth\/refresh/);
  assert.match(server, /consumeRefreshToken/);
  assert.match(storage, /d\.refreshTokens \?\?=/);
  assert.match(app, /bloom-refresh-token/);
});

test('auth page uses a soft pink-purple gradient theme', () => {
  const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(page, /linear-gradient\(90deg,#cbb9e0 0%,#d9c0dc 46%,#e9c8d9 100%\)/);
  assert.match(page, /background:rgba\(255,255,255,.16\)/);
});

test('daily learning assessment has fill, choice, and response sections', () => {
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const storage = fs.readFileSync(path.join(__dirname, 'storage.js'), 'utf8');
  assert.match(app, /学习检测/);
  assert.match(app, /填空题/);
  assert.match(app, /选择题/);
  assert.match(app, /应答题/);
  assert.match(app, /共 100 题/);
  assert.match(app, /34 填空、33 选择、33 应答/);
  assert.match(server, /paper\.length!==total/);
  assert.match(server, /counts\.fill!==typeTotals\.fill/);
  assert.match(server, /kind==='weekly'/);
  assert.match(app, /weekly-fill-/);
  assert.match(app, /查看答案与解析/);
  assert.match(app, /quizChart/);
  assert.match(app, /weeklyQuizPage/);
  assert.match(app, /typeTotals/);
  assert.match(app, /api\/quiz-results/);
  assert.match(server, /api\/quiz-results/);
  assert.match(storage, /d\.quizResults \?\?=/);
});
