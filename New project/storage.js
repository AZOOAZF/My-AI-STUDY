const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, 'data.json');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || process.env.CONTEXT === 'production' || process.env.VERCEL_ENV === 'production';
const USE_SUPABASE = /^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(SUPABASE_URL) && Boolean(SUPABASE_SECRET_KEY);
let fallbackData;

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
