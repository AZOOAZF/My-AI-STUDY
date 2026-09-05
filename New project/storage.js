const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, 'data.json');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);

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
  const sourceTasks = d.tasks?.length ? d.tasks : seedTasks();
  d.tasks = sourceTasks.slice(0, 56).map((task, index) => {
    const { date, ...rest } = task || {};
    return { ...rest, id: index + 1, day: index + 1, week: Math.floor(index / 7) + 1 };
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
  if (!USE_SUPABASE) return localData(seedTasks);

  const response = await fetch(`${SUPABASE_URL}/rest/v1/app_state?id=eq.main&select=data`, {
    headers: headers(),
  });
  if (!response.ok) throw new Error(`Supabase read failed: ${response.status} ${await response.text()}`);

  const rows = await response.json();
  if (rows[0]?.data) return normalize(rows[0].data, seedTasks);

  const initial = localData(seedTasks);
  await save(initial);
  return initial;
}

async function save(data) {
  if (!USE_SUPABASE) {
    fs.writeFileSync(DB, JSON.stringify(data, null, 2));
    return;
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=id`, {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify([{ id: 'main', data, updated_at: new Date().toISOString() }]),
  });
  if (!response.ok) throw new Error(`Supabase write failed: ${response.status} ${await response.text()}`);
}

module.exports = { load, save, USE_SUPABASE };
