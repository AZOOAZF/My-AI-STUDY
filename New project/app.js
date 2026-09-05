(function () {
  var app = document.getElementById('app');
  var token = localStorage.getItem('bloom-token');
  var me;
  var tasks = [];
  var progress = {};
  var notes = [];
  var posts = [];
  var tab = '课程学习';
  var authMode = 'login';
  var authMethod = 'code';
  var passwordPromptSkipped = false;
  var passwordReturnToProfile = false;

  function esc(x) {
    return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {});
    return fetch(path, options).then(function (response) {
      return response.text().then(function (raw) {
        var data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (e) { throw Error('服务器返回了无效响应'); }
        if (!response.ok) throw Error(data.error || '请求失败');
        return data;
      });
    });
  }

  function authPage(mode, method) {
    authMode = mode || 'login';
    if (authMode === 'register') authMethod = 'code';
    else if (method) authMethod = method;
    else authMethod = 'code';
    var passwordLogin = authMode === 'login' && authMethod === 'password';
    app.innerHTML = '<main class="auth-page"><section class="auth-panel"><div class="auth-card"><div class="brand">AI <b>BLOOM</b></div><h1>' + (authMode === 'register' ? '创建学习账户' : '欢迎回来') + '</h1><p class="muted">' + (authMode === 'register' ? '一个邮箱只能注册一个账户，注册后先完成简洁学习档案。' : (passwordLogin ? '使用已设置的邮箱和密码快速登录。' : '使用注册邮箱接收验证码，忘记密码时也可用验证码找回。')) + '</p><div class="auth-tabs"><button class="' + (authMode === 'login' ? 'active' : '') + '" onclick="authPage(\'login\')">登录</button><button class="' + (authMode === 'register' ? 'active' : '') + '" onclick="authPage(\'register\')">注册</button></div>' + (authMode === 'login' ? '<div class="auth-methods"><button class="' + (!passwordLogin ? 'active' : '') + '" onclick="authPage(\'login\',\'code\')">验证码登录</button><button class="' + (passwordLogin ? 'active' : '') + '" onclick="authPage(\'login\',\'password\')">密码登录</button></div>' : '') + '<div class="field"><label>邮箱地址</label><input id="authEmail" type="email" autocomplete="email" placeholder="name@example.com"></div>' + (passwordLogin ? '<div class="field"><label>登录密码</label><input id="authPassword" type="password" autocomplete="current-password" placeholder="请输入已设置的密码"></div>' : '<div class="field"><label>邮箱验证码</label><div class="code-row"><input id="authCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6 位验证码"><button class="btn secondary" id="sendCode" onclick="requestCode()">获取验证码</button></div></div>') + '<div id="authError" class="form-error"></div><button class="btn" style="width:100%" id="authSubmit" onclick="' + (passwordLogin ? 'submitPasswordLogin()' : 'submitAuth()') + '">' + (authMode === 'register' ? '注册并继续' : '登录') + '</button><p class="form-tip">继续即表示你同意将邮箱用于账户验证和必要服务通知。</p></div></section><aside class="auth-scene"><div class="scene-copy"><h2>把每一次学习，沉淀成自己的成长轨迹。</h2><p>支持 QQ、网易、Gmail、Outlook、iCloud 等常见邮箱。</p><div class="mail-list"><span>QQ 邮箱</span><span>网易邮箱</span><span>Gmail</span><span>Outlook</span><span>iCloud Mail</span></div></div></aside></main>';
  }

  function requestCode() {
    var email = document.getElementById('authEmail').value.trim();
    var button = document.getElementById('sendCode');
    var error = document.getElementById('authError');
    error.textContent = '';
    error.style.color = 'var(--danger)';
    if (!email) { error.textContent = '请先填写邮箱地址'; return; }
    button.disabled = true;
    api('/api/auth/request-code', { method: 'POST', body: JSON.stringify({ email: email, purpose: authMode }) }).then(function (data) {
      var left = 60;
      button.textContent = left + ' 秒后重试';
      var timer = setInterval(function () {
        left--;
        button.textContent = left + ' 秒后重试';
        if (left <= 0) { clearInterval(timer); button.disabled = false; button.textContent = '重新发送'; }
      }, 1000);
      error.style.color = 'var(--green)';
      error.textContent = data.message + (data.devCode ? '（本地验证码：' + data.devCode + '）' : '');
    }).catch(function (e) { button.disabled = false; error.textContent = e.message; });
  }

  function acceptLogin(data) {
    token = data.token;
    localStorage.setItem('bloom-token', token);
    boot();
  }

  function submitAuth() {
    var error = document.getElementById('authError');
    var submit = document.getElementById('authSubmit');
    error.style.color = 'var(--danger)';
    error.textContent = '';
    submit.disabled = true;
    api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: document.getElementById('authEmail').value.trim(), code: document.getElementById('authCode').value.trim(), purpose: authMode }) }).then(acceptLogin).catch(function (e) { error.textContent = e.message; }).finally(function () { submit.disabled = false; });
  }

  function submitPasswordLogin() {
    var error = document.getElementById('authError');
    var submit = document.getElementById('authSubmit');
    error.textContent = '';
    submit.disabled = true;
    api('/api/auth/password-login', { method: 'POST', body: JSON.stringify({ email: document.getElementById('authEmail').value.trim(), password: document.getElementById('authPassword').value }) }).then(acceptLogin).catch(function (e) { error.textContent = e.message; }).finally(function () { submit.disabled = false; });
  }

  function boot() {
    Promise.all([api('/api/me'), api('/api/tasks'), api('/api/progress'), api('/api/notes'), api('/api/forum')]).then(function (items) {
      me = items[0].user;
      tasks = items[1].tasks || [];
      progress = items[2].progress || {};
      notes = items[3].notes || [];
      posts = items[4].posts || [];
      if (me.role !== 'admin' && !me.profileCompleted) { profilePage(true); return; }
      if (me.role !== 'admin' && !me.passwordSet && !passwordPromptSkipped) { passwordSetupPage(false); return; }
      render();
    }).catch(function () { localStorage.removeItem('bloom-token'); token = null; authPage('login'); });
  }

  function shell(content) {
    app.innerHTML = '<header class="top"><div class="brand">AI <b>BLOOM</b></div><nav class="tags">' + ['课程学习', '学习笔记', '问题论坛', '我的'].map(function (item) { return '<button class="' + (tab === item ? 'active' : '') + '" onclick="switchTab(\'' + item + '\')">' + item + '</button>'; }).join('') + '</nav><div class="avatar">' + esc((me.nickname || me.email || '?')[0].toUpperCase()) + '</div></header><main class="main">' + content + '</main>';
  }

  function progressFor(task) { return progress[String(task.day || task.id)] || {}; }

  function render() {
    if (me.role === 'admin') return admin();
    if (!me.profileCompleted) return profilePage(true);
    if (!me.passwordSet && !passwordPromptSkipped) return passwordSetupPage(false);
    if (tab === '学习笔记') return notesPage();
    if (tab === '问题论坛') return forumPage();
    if (tab === '我的') return profilePage(false);
    var done = Object.values(progress).filter(function (item) { return item.done; }).length;
    var today = tasks.find(function (item) { return !progressFor(item).done; }) || tasks[0];
    shell('<div class="welcome"><div><div class="eyebrow">HELLO, ' + esc(me.nickname || me.email.split('@')[0]) + '</div><h1>今天也要发光</h1><p class="muted">每学期按第 1 天到第 56 天，每天完成一次打卡。</p></div><button class="btn ghost" onclick="logout()">退出</button></div><div class="grid"><section><div class="card hero"><div class="eyebrow">DAY ' + today.day + ' · ' + esc(today.module) + '</div><h2>' + esc(today.title) + '</h2><p>' + esc(today.description) + '</p><button class="btn secondary" onclick="toggle(' + today.day + ')">' + (progressFor(today).done ? '第 ' + today.day + ' 天已完成 ✓' : '完成第 ' + today.day + ' 天打卡') + '</button></div><div class="stats"><div class="stat"><b>' + done + '</b><span>完成天数</span></div><div class="stat"><b>' + (tasks.length ? Math.round(done / tasks.length * 100) : 0) + '%</b><span>总进度</span></div><div class="stat"><b>' + Object.values(progress).reduce(function (sum, item) { return sum + (item.minutes || 0); }, 0) + '</b><span>累计分钟</span></div></div><div class="card"><h2>56 天打卡表</h2><div class="checkin-table-wrap"><table class="checkin-table"><thead><tr><th>天数</th><th>学习模块</th><th>当天任务</th><th>时长</th><th>状态</th><th>操作</th></tr></thead><tbody>' + tasks.map(taskRow).join('') + '</tbody></table></div></div></section><aside class="card"><h2>每周节奏</h2><p class="muted">每 7 天为一周，理论、案例、实操与复盘轮换。</p><div class="stats">' + [1, 2, 3, 4, 5, 6, 7, 8].map(function (week) { return '<div class="stat"><b>' + tasks.filter(function (task) { return task.week === week && progressFor(task).done; }).length + '</b><span>第 ' + week + ' 周</span></div>'; }).join('') + '</div></aside></div>');
  }

  function taskRow(task) {
    var record = progressFor(task);
    return '<tr><td><span class="day-badge">第 ' + task.day + ' 天</span><div class="task-meta">第 ' + task.week + ' 周</div></td><td>' + esc(task.module) + '</td><td><strong>' + esc(task.title) + '</strong><div class="task-meta">' + esc(task.description) + '</div>' + (task.practice ? '<div class="lesson-box"><b>实操：</b>' + esc(task.practice) + '</div>' : '') + (task.question ? '<div class="quiz-box"><b>检测题：</b>' + esc(task.question) + '<br><button class="quiz-btn" onclick="this.nextElementSibling.classList.toggle(\'show\')">查看参考答案</button><span class="quiz-answer">' + esc(task.answer) + '</span></div>' : '') + '<a href="' + esc(task.resource) + '" target="_blank" rel="noopener">打开课程入口 ↗</a></td><td>' + esc(task.minutes) + ' 分钟</td><td class="' + (record.done ? 'status-done' : 'muted') + '">' + (record.done ? '已完成 ✓' : '待打卡') + '</td><td><button class="btn ' + (record.done ? 'ghost' : 'secondary') + '" onclick="toggle(' + task.day + ')">' + (record.done ? '撤销' : '完成') + '</button></td></tr>';
  }

  function passwordSetupPage(returnToProfile) {
    passwordReturnToProfile = !!returnToProfile;
    app.innerHTML = '<main class="main onboarding"><div class="onboarding-head"><div class="brand">AI <b>BLOOM</b></div><div class="eyebrow">ACCOUNT SECURITY</div><h1>' + (passwordReturnToProfile ? '修改登录密码' : '设置登录密码') + '</h1><p class="muted">设置后，下次可以直接用邮箱和密码登录；忘记密码时可用邮箱验证码登录后在“我的”里重设。</p></div><section class="card password-card"><div class="field"><label>新密码</label><input id="newPassword" type="password" autocomplete="new-password" placeholder="至少 8 位，包含字母和数字"></div><div class="field"><label>再次输入</label><input id="confirmPassword" type="password" autocomplete="new-password" placeholder="再次输入密码"></div><div id="passwordMsg" class="form-error"></div><div class="save-row"><button class="btn ghost" onclick="skipPassword()">' + (passwordReturnToProfile ? '返回我的' : '暂时使用验证码') + '</button><button class="btn" onclick="savePassword()">保存密码</button></div></section></main>';
  }

  function savePassword() {
    var message = document.getElementById('passwordMsg');
    message.style.color = 'var(--danger)';
    api('/api/auth/password', { method: 'POST', body: JSON.stringify({ password: document.getElementById('newPassword').value, confirmPassword: document.getElementById('confirmPassword').value }) }).then(function (data) {
      me = data.user;
      passwordPromptSkipped = false;
      message.style.color = 'var(--green)';
      message.textContent = '密码已保存';
      setTimeout(function () { if (passwordReturnToProfile) { tab = '我的'; render(); } else render(); }, 250);
    }).catch(function (e) { message.textContent = e.message; });
  }

  function skipPassword() { if (passwordReturnToProfile) { tab = '我的'; render(); } else { passwordPromptSkipped = true; render(); } }

  function inputField(label, id, value, placeholder, required) {
    return '<div class="field"><label>' + label + (required ? ' <span class="required">*</span>' : '') + '</label><input id="' + id + '" value="' + esc(value || '') + '" placeholder="' + esc(placeholder || '') + '"></div>';
  }

  function selectField(label, id, value, options, required) {
    return '<div class="field"><label>' + label + (required ? ' <span class="required">*</span>' : '') + '</label><select id="' + id + '"><option value="">请选择</option>' + options.map(function (item) { return '<option value="' + esc(item) + '" ' + (String(value || '') === item ? 'selected' : '') + '>' + esc(item) + '</option>'; }).join('') + '</select></div>';
  }

  function checkGroup(name, options, selected) {
    selected = selected || [];
    return '<div class="checks ' + name + '-checks">' + options.map(function (item) { return '<label class="check"><input type="checkbox" name="' + name + '" value="' + esc(item) + '" ' + (selected.includes(item) ? 'checked' : '') + '>' + esc(item) + '</label>'; }).join('') + '</div>';
  }

  var goalOptions = ['建立 AI 基础', '完成作品集', '提升工作效率', '准备求职或升学', '探索创业方向', '系统学习编程'];
  var interestOptions = ['Python', '大模型原理', '提示词工程', 'RAG', 'AI Agent', '自动化', '数据分析', '产品设计', '模型部署', '开源项目'];

  function profileForm(first) {
    var goals = me.learningGoals || (me.learningGoal ? String(me.learningGoal).split('、') : []);
    var interests = me.interests || [];
    return '<div class="card compact-profile"><h3 class="section-title">用选项快速完成资料</h3><p class="muted">只保留会影响学习推荐的信息，之后可以在“我的”里随时调整。</p><div class="form-grid">' + inputField('昵称', 'pn', me.nickname, '社区中展示的名称', true) + selectField('国家或地区', 'pco', me.country, ['中国', '中国香港', '中国澳门', '中国台湾', '美国', '加拿大', '英国', '日本', '韩国', '其他'], true) + selectField('AI 经验水平', 'pel', me.experienceLevel, ['刚刚开始', '了解基础概念', '做过小项目', '能够独立开发', '专业从业者'], true) + selectField('每周学习时间', 'pwh', me.weeklyHours, ['少于 3 小时', '3-5 小时', '6-10 小时', '11-20 小时', '20 小时以上']) + selectField('常用学习时段', 'pst', me.preferredStudyTime, ['清晨', '上午', '下午', '晚上', '不固定']) + selectField('界面语言', 'plang', me.language, ['简体中文', '繁體中文', 'English']) + '</div><div class="field"><label>学习目标（可多选） <span class="required">*</span></label>' + checkGroup('goal', goalOptions, goals) + '</div><div class="field"><label>感兴趣的方向（可多选）</label>' + checkGroup('interest', interestOptions, interests) + '</div><div class="form-grid">' + selectField('偏好的学习方式', 'pls', me.learningStyle, ['系统课程', '项目实战', '阅读文档', '视频学习', '社区讨论']) + selectField('时区', 'ptz', me.timezone, ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'America/Los_Angeles']) + '</div><label class="check"><input id="pdiscover" type="checkbox" ' + (me.allowDiscovery ? 'checked' : '') + '>允许其他学习者通过社区资料认识我</label><div class="save-row"><span id="profileMsg" class="form-error"></span><button class="btn" onclick="saveProfile(' + !!first + ')">' + (first ? '完成资料并开始学习' : '保存资料') + '</button></div></div>';
  }

  function profilePage(first) {
    var required = [me.nickname, me.country, me.experienceLevel, (me.learningGoals && me.learningGoals.length) || me.learningGoal].filter(Boolean).length;
    var percent = Math.round(required / 4 * 100);
    var form = profileForm(first);
    if (first) {
      app.innerHTML = '<main class="main onboarding"><div class="onboarding-head"><div class="brand">AI <b>BLOOM</b></div><div class="eyebrow">FIRST STEP</div><h1>先创建你的学习档案</h1><p class="muted">选择几项信息即可开始，带星号的项目为必填。</p></div>' + form + '</main>';
      return;
    }
    shell('<div class="welcome"><div><div class="eyebrow">YOUR SPACE</div><h1>我的</h1><p class="muted">管理身份、学习目标与偏好。</p></div><button class="btn ghost" onclick="logout()">退出账户</button></div><div class="profile-layout"><aside class="card profile-summary"><div class="profile-avatar">' + esc((me.nickname || me.email)[0].toUpperCase()) + '</div><h2>' + esc(me.nickname || '未设置昵称') + '</h2><p class="muted">' + esc(me.email) + '</p><p>' + esc(me.learningGoal || '尚未设置学习目标') + '</p><b>档案完整度 ' + percent + '%</b><div class="profile-completion"><i style="width:' + percent + '%"></i></div><p class="form-tip">注册时间：' + esc((me.registeredAt || '').slice(0, 10) || '未知') + '</p><button class="btn secondary" onclick="passwordSetupPage(true)">修改登录密码</button></aside><section>' + form + '</section></div>');
  }

  function saveProfile(first) {
    var goals = Array.from(document.querySelectorAll('input[name=goal]:checked')).map(function (item) { return item.value; });
    var values = { nickname: document.getElementById('pn').value, country: document.getElementById('pco').value, experienceLevel: document.getElementById('pel').value, weeklyHours: document.getElementById('pwh').value, learningGoals: goals, interests: Array.from(document.querySelectorAll('input[name=interest]:checked')).map(function (item) { return item.value; }), learningStyle: document.getElementById('pls').value, preferredStudyTime: document.getElementById('pst').value, language: document.getElementById('plang').value, timezone: document.getElementById('ptz').value, allowDiscovery: document.getElementById('pdiscover').checked };
    var message = document.getElementById('profileMsg');
    message.textContent = '保存中...';
    message.style.color = 'var(--muted)';
    api('/api/profile', { method: 'PUT', body: JSON.stringify(values) }).then(function (data) {
      me = data.user;
      if (first && !me.passwordSet) passwordSetupPage(false);
      else if (first) { tab = '课程学习'; render(); }
      else { message.style.color = 'var(--green)'; message.textContent = '资料已保存'; }
    }).catch(function (e) { message.style.color = 'var(--danger)'; message.textContent = e.message; });
  }

  function switchTab(next) { tab = next; render(); }

  function toggle(day) {
    var key = String(day);
    var record = progress[key] || {};
    api('/api/progress', { method: 'POST', body: JSON.stringify({ day: Number(day), done: !record.done, minutes: 120, note: record.note || '' }) }).then(function (data) { progress[key] = data.progress; render(); });
  }

  function notesPage() { shell('<div class="welcome"><div><div class="eyebrow">YOUR NOTES</div><h1>学习笔记</h1><p class="muted">把今天的理解变成明天的捷径。</p></div></div><div class="grid"><section class="card"><h2>写一条新笔记</h2><div class="field"><input id="nt" placeholder="标题"></div><div class="field"><textarea id="nc" rows="7" placeholder="记录概念、代码或灵感"></textarea></div><button class="btn" onclick="addNote()">保存笔记</button></section><section class="card"><h2>最近笔记</h2>' + (notes.length ? notes.map(function (note) { return '<div class="note"><div><b>' + esc(note.title) + '</b><p class="muted">' + esc(note.content) + '</p></div></div>'; }).join('') : '<div class="empty">还没有笔记。</div>') + '</section></div>'); }

  function forumPage() { shell('<div class="welcome"><div><div class="eyebrow">COMMUNITY</div><h1>问题论坛</h1><p class="muted">提问、交流，一起解决学习卡点。</p></div></div><section class="card"><div class="field"><input id="pt" placeholder="问题标题"></div><div class="field"><textarea id="pc" rows="3" placeholder="描述你的问题"></textarea></div><button class="btn" onclick="addPost()">发布问题</button>' + (posts.length ? posts.map(function (post) { return '<div class="post"><div><b>' + esc(post.title) + '</b><p>' + esc(post.content) + '</p><span class="muted">' + esc(post.author) + '</span></div></div>'; }).join('') : '<div class="empty">论坛还很安静，来发起第一个问题。</div>') + '</section>'); }

  function addNote() { api('/api/notes', { method: 'POST', body: JSON.stringify({ title: document.getElementById('nt').value, content: document.getElementById('nc').value }) }).then(function (data) { notes.unshift(data.note); render(); }); }
  function addPost() { api('/api/forum', { method: 'POST', body: JSON.stringify({ title: document.getElementById('pt').value, content: document.getElementById('pc').value }) }).then(function (data) { posts.unshift(data.post); render(); }); }
  function logout() { localStorage.removeItem('bloom-token'); token = null; me = null; authPage('login'); }
  function admin() { api('/api/admin/stats').then(function (stats) { app.innerHTML = '<main class="main"><section class="card"><div class="brand">AI <b>BLOOM</b></div><h1>运营控制台</h1><div class="stats"><div class="stat"><b>' + stats.users + '</b><span>用户</span></div><div class="stat"><b>' + stats.records + '</b><span>打卡</span></div><div class="stat"><b>' + stats.posts + '</b><span>帖子</span></div></div><button class="btn ghost" onclick="logout()">退出</button></section></main>'; }); }

  window.authPage = authPage;
  window.requestCode = requestCode;
  window.submitAuth = submitAuth;
  window.submitPasswordLogin = submitPasswordLogin;
  window.savePassword = savePassword;
  window.skipPassword = skipPassword;
  window.passwordSetupPage = passwordSetupPage;
  window.saveProfile = saveProfile;
  window.switchTab = switchTab;
  window.toggle = toggle;
  window.addNote = addNote;
  window.addPost = addPost;
  window.logout = logout;
  if (token) boot(); else authPage('login');
}());
