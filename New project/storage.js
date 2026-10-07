const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, 'data.json');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.CONTEXT === 'production' || process.env.VERCEL_ENV === 'production';
const USE_SUPABASE = /^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(SUPABASE_URL) && Boolean(SUPABASE_SECRET_KEY);
let fallbackData;

const PROJECTS = [
  { title: '个人学习资料 CLI', brief: '把零散的学习记录变成一个可查询、可复盘的命令行工具。', roles: ['产品负责人', 'Python 开发者', '测试负责人'] },
  { title: '数据清洗与周报工具', brief: '接收一份真实数据，清洗、统计并生成一份可读的学习周报。', roles: ['数据分析师', '实现者', '质量负责人'] },
  { title: 'Prompt 评测工作台', brief: '做一个能保存提示词、运行样例并比较输出质量的小型工作台。', roles: ['产品设计师', '提示词工程师', '评测负责人'] },
  { title: '个人知识库 RAG', brief: '把自己的资料整理成可检索知识库，并让回答带有可靠引用。', roles: ['知识库设计师', '检索工程师', '验证负责人'] },
  { title: '学习助理 Agent', brief: '构建一个能拆解学习任务、调用工具并记录进度的助理。', roles: ['Agent 架构师', '工具开发者', '安全评审员'] },
  { title: '可部署 AI 服务', brief: '把一个 AI 功能封装成可配置、可观测、可部署的网络服务。', roles: ['服务架构师', '接口开发者', '发布负责人'] },
  { title: '作品集产品化', brief: '将前面的小实验整理成一个用户能理解、能使用、能评价的作品。', roles: ['产品负责人', '体验设计师', '展示负责人'] },
  { title: 'AI 学习伙伴毕业项目', brief: '独立完成一个从需求到发布的 AI 应用，并用证据说明它解决了什么问题。', roles: ['项目负责人', '技术负责人', '复盘主持人'] },
];

const PROJECT_PHASES = [
  { title: '项目立项', action: '明确用户、场景和成功标准' },
  { title: '最小原型', action: '把知识点变成一个最小可运行样例' },
  { title: '核心功能', action: '完成项目最重要的一条输入到输出链路' },
  { title: '数据与体验', action: '补充真实输入、异常情况和可读输出' },
  { title: '验证与反馈', action: '用测试样例检查结果并根据反馈修正' },
  { title: '交付准备', action: '整理使用说明、示例和演示材料' },
  { title: '周演示与复盘', action: '展示产出、记录问题并规划下一步' },
];

function unavailable(reason) {
  console.error('[storage] Persistent storage unavailable:', reason);
  const error = new Error('持久化数据库暂时不可用，请联系网站管理员');
  error.statusCode = 503;
  return error;
}

function enrichTask(task, index) {
  const day = index + 1;
  const week = Math.floor(index / 7) + 1;
  const minutes = Number(task.minutes) || 120;
  const project = PROJECTS[week - 1] || PROJECTS[PROJECTS.length - 1];
  const phase = PROJECT_PHASES[index % PROJECT_PHASES.length];
  const projectData = {
    title: project.title,
    brief: project.brief,
    role: project.roles[index % project.roles.length],
    milestone: phase.title,
    goal: `围绕“${task.title}”，${phase.action}。`,
    deliverable: task.practice || `提交一份${task.title}练习结果。`,
    acceptance: [
      `能用一个真实例子演示${phase.action}。`,
      `能说明“${task.title}”在本周项目中的作用。`,
      '留下可复现的结果，并记录一个下一步改进点。',
    ],
    reflection: `复盘：如果把这一步交给别人接手，最需要补充哪一条说明？`,
  };
  const quizFacts = [
    { prompt: task.question || `第 ${day} 天最重要的知识点是什么？`, answer: task.answer || task.title, explanation: task.description || task.title },
    { prompt: `第 ${day} 天的课程主题是什么？`, answer: task.title, explanation: `本日围绕“${task.title}”展开。` },
    { prompt: `“${task.title}”属于哪个学习模块？`, answer: task.module, explanation: `课程路径将本日归入“${task.module}”。` },
    { prompt: `第 ${day} 天建议投入多少分钟？`, answer: String(minutes), explanation: `理解、跟做、实操和复盘合计 ${minutes} 分钟。` },
    { prompt: `第 ${day} 天使用的主要学习资料是什么？`, answer: task.source || '课程资料', explanation: `课程入口来自“${task.source || '课程资料'}”。` },
  ];
  return {
    ...task,
    id: day,
    day,
    week,
    project: projectData,
    outcomes: [
      `能用自己的话解释“${task.title}”`,
      `能独立完成：${task.practice || task.description}`,
      `能回答：${task.question || `什么是${task.title}`}`,
    ],
    agenda: [
      { label: '理解概念', minutes: 25, detail: task.description || `理解${task.title}的核心概念。` },
      { label: '跟做示例', minutes: 25, detail: `打开${task.source || '课程资料'}，跟随一个完整示例。` },
      { label: '独立实操', minutes: 50, detail: task.practice || `独立完成一个${task.title}练习。` },
      { label: '检测复盘', minutes: 20, detail: task.masteryTarget || '完成检测并记录一个错误与改进。' },
    ],
    deliverable: task.practice || `提交一份${task.title}练习结果。`,
    quizFacts,
  };
}

function normalize(d, seedTasks) {
  d = d && typeof d === 'object' ? d : {};
  d.users ??= {};
  d.progress ??= {};
  d.notes ??= {};
  d.posts ??= [];
  d.products ??= [];
  d.orders ??= {};
  d.paymentEvents ??= {};
  d.emailJobs ??= [];
  d.authCodes ??= {};
  d.refreshTokens ??= {};
  d.quizResults ??= {};
  const savedTasks = Array.isArray(d.tasks) ? d.tasks : [];
  const canonicalTasks = seedTasks();
  const sourceTasks = canonicalTasks.length ? canonicalTasks : savedTasks;
  d.tasks = sourceTasks.slice(0, 56).map((task, index) => {
    const { date, ...rest } = task || {};
    const saved = savedTasks[index] || {};
    return enrichTask({ ...saved, ...rest }, index);
  });
  for (const email of Object.keys(d.progress)) {
    const records = d.progress[email] || {};
    const migrated = {};
    for (const [key, value] of Object.entries(records)) {
      const raw = String(key);
      let day = /^\d+$/.test(raw) ? Number(raw) : 0;
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      if (!day && match) {
        const start = Date.UTC(2026, 8, 3);
        const current = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        day = Math.floor((current - start) / 86400000) + 1;
      }
      if (day >= 1 && day <= 56) migrated[String(day)] = { ...value, day };
      else migrated[raw] = value;
    }
    d.progress[email] = migrated;
  }
  return d;
}

function localData(seedTasks) {
  try {
    return normalize(JSON.parse(fs.readFileSync(DB, 'utf8')), seedTasks);
  } catch {
    return normalize({}, seedTasks);
  }
}

function headers(extra = {}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function load(seedTasks) {
  if (!USE_SUPABASE) {
    if (IS_PRODUCTION) throw unavailable('Supabase configuration is missing or invalid');
    if (fallbackData) return normalize(fallbackData, seedTasks);
    return localData(seedTasks);
  }
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/app_state?id=eq.main&select=data`, {
      headers: headers(),
    });
    if (!response.ok) throw new Error(`Supabase read failed: ${response.status}`);
    const rows = await response.json();
    if (rows[0]?.data) return normalize(rows[0].data, seedTasks);
    const initial = localData(seedTasks);
    await save(initial);
    return initial;
  } catch (error) {
    console.error('[storage] Supabase read unavailable:', error.message);
    if (IS_PRODUCTION) throw unavailable(error.message);
    fallbackData = localData(seedTasks);
    return fallbackData;
  }
}

async function save(data) {
  if (!USE_SUPABASE) {
    if (IS_PRODUCTION) throw unavailable('Supabase configuration is missing or invalid');
    fallbackData = data;
    try { fs.writeFileSync(DB, JSON.stringify(data, null, 2)); } catch (error) { console.error('[storage] local write unavailable:', error.message); }
    return;
  }
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=id`, {
      method: 'POST',
      headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ id: 'main', data, updated_at: new Date().toISOString() }]),
    });
    if (!response.ok) throw new Error(`Supabase write failed: ${response.status}`);
    fallbackData = data;
  } catch (error) {
    console.error('[storage] Supabase write unavailable:', error.message);
    if (IS_PRODUCTION) throw unavailable(error.message);
    fallbackData = data;
  }
}

module.exports = { load, save, USE_SUPABASE };
