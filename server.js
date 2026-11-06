/* Restaurant Control – employee records, daily sales, expenses, reports and expiry alerts */
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const TZ = process.env.APP_TIMEZONE || 'Asia/Dubai';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'cuftheria.db'));
db.pragma('journal_mode = WAL');

/* ------------------------------------------------------------------ database */
const USERS_SQL = `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','user')),
  branch_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`;
// Upgrade an older database (version 1 had only admin/user roles)
const oldUsers = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
if (oldUsers && !oldUsers.sql.includes("'manager'")) {
  db.exec(`ALTER TABLE users RENAME TO users_old;
    ${USERS_SQL};
    INSERT INTO users (id, username, password_hash, role, created_at)
      SELECT id, username, password_hash, role, created_at FROM users_old;
    DROP TABLE users_old;`);
}
db.exec(`
${USERS_SQL};
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_code TEXT, name TEXT NOT NULL, job_title TEXT, phone TEXT, email TEXT, nationality TEXT,
  branch_id INTEGER REFERENCES branches(id), work_location TEXT, salary REAL,
  passport_no TEXT, passport_expiry TEXT, visa_type TEXT, visa_no TEXT, visa_expiry TEXT, notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_emp_name ON employees(name);
CREATE TABLE IF NOT EXISTS daily_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  date TEXT NOT NULL,
  cash REAL NOT NULL DEFAULT 0, card REAL NOT NULL DEFAULT 0,
  delivery REAL NOT NULL DEFAULT 0, other REAL NOT NULL DEFAULT 0,
  notes TEXT, updated_by TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (branch_id, date)
);
CREATE INDEX IF NOT EXISTS idx_sales_date ON daily_sales(date);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  date TEXT NOT NULL, category TEXT NOT NULL, amount REAL NOT NULL,
  description TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_exp_date ON expenses(date);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, data TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (type, period_start)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
  sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (emp_id, kind, key)
);
`);

const CATEGORIES = ['Food & Ingredients', 'Rent', 'Utilities', 'Maintenance', 'Marketing', 'Transport', 'Supplies', 'Other'];

if (db.prepare('SELECT COUNT(*) c FROM branches').get().c === 0) {
  const ins = db.prepare('INSERT INTO branches (name) VALUES (?)');
  for (let i = 1; i <= 25; i++) ins.run('Branch ' + i);
}
if (db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c === 0) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)')
    .run('admin', bcrypt.hashSync(pw, 10), 'admin');
  console.log('\n=== FIRST RUN: administrator account created ===');
  console.log('Username: admin');
  console.log('Password: ' + pw);
  console.log('Log in and change this password right away.\n');
}
const secretFile = path.join(DATA_DIR, 'session-secret.txt');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8');

/* ------------------------------------------------------------------ settings */
const DEFAULTS = { currency: 'AED', alert_phones: '', alert_days: '60,30,7', sms_reports: '0', last_alert_run: '' };
const getSetting = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : DEFAULTS[k]; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const phoneList = () => getSetting('alert_phones').split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
const thresholds = () => {
  const t = getSetting('alert_days').split(/[,\s;]+/).map(Number).filter(n => Number.isFinite(n) && n >= 0);
  return (t.length ? t : [60, 30, 7]).sort((a, b) => a - b);
};
const smsConfigured = () => !!(process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM);

/* ------------------------------------------------------------------ dates (all in the business time zone) */
const ymd = d => d.toISOString().slice(0, 10);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const hourNow = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
const mondayOf = s => addDays(s, -((new Date(s + 'T00:00:00Z').getUTCDay() + 6) % 7));
const monthStart = s => s.slice(0, 8) + '01';
const monthEnd = s => { const d = new Date(monthStart(s) + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return ymd(d); };
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* ------------------------------------------------------------------ reports */
// Payroll is taken from employee salaries (monthly) and pro-rated for the days in the period.
function payrollFactor(from, to) {
  let f = 0, cur = from;
  while (cur <= to) {
    const ms = monthStart(cur), me = monthEnd(cur), end = to < me ? to : me;
    f += (daysBetween(cur, end) + 1) / (daysBetween(ms, me) + 1);
    cur = addDays(me, 1);
  }
  return f;
}
function buildReport(from, to, { branchId = null, payroll = true } = {}) {
  const where = branchId ? ' AND branch_id=?' : '';
  const args = branchId ? [from, to, branchId] : [from, to];
  const sales = db.prepare(`SELECT branch_id, SUM(cash) cash, SUM(card) card, SUM(delivery) delivery, SUM(other) other, COUNT(*) days
    FROM daily_sales WHERE date BETWEEN ? AND ?${where} GROUP BY branch_id`).all(...args);
  const exp = db.prepare(`SELECT branch_id, category, SUM(amount) amt FROM expenses
    WHERE date BETWEEN ? AND ?${where} GROUP BY branch_id, category`).all(...args);
  const pay = payroll ? db.prepare('SELECT branch_id, SUM(salary) s, COUNT(*) n FROM employees WHERE salary IS NOT NULL GROUP BY branch_id').all() : [];
  const factor = payrollFactor(from, to);
  const blank = () => ({ cash: 0, card: 0, delivery: 0, other: 0, income: 0, expenseByCat: {}, expenses: 0, payroll: 0, totalExpenses: 0, profit: 0, salesDays: 0 });
  const rows = db.prepare('SELECT id, name FROM branches' + (branchId ? ' WHERE id=?' : '') + ' ORDER BY id').all(...(branchId ? [branchId] : []))
    .map(b => ({ id: b.id, name: b.name, ...blank() }));
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  for (const s of sales) { const r = by[s.branch_id]; if (!r) continue; r.cash = s.cash; r.card = s.card; r.delivery = s.delivery; r.other = s.other; r.salesDays = s.days; }
  for (const e of exp) { const r = by[e.branch_id]; if (!r) continue; r.expenseByCat[e.category] = (r.expenseByCat[e.category] || 0) + e.amt; r.expenses += e.amt; }
  for (const p of pay) { const r = by[p.branch_id]; if (r) r.payroll = p.s * factor; }
  const total = { ...blank(), name: 'TOTAL' };
  for (const r of rows) {
    r.income = r.cash + r.card + r.delivery + r.other;
    r.totalExpenses = r.expenses + r.payroll;
    r.profit = r.income - r.totalExpenses;
    for (const k of ['cash', 'card', 'delivery', 'other', 'income', 'expenses', 'payroll', 'totalExpenses', 'profit']) total[k] += r[k];
    for (const [c, v] of Object.entries(r.expenseByCat)) total.expenseByCat[c] = (total.expenseByCat[c] || 0) + v;
    for (const k of ['cash', 'card', 'delivery', 'other', 'income', 'expenses', 'payroll', 'totalExpenses', 'profit']) r[k] = r2(r[k]);
    for (const c of Object.keys(r.expenseByCat)) r.expenseByCat[c] = r2(r.expenseByCat[c]);
  }
  for (const k of ['cash', 'card', 'delivery', 'other', 'income', 'expenses', 'payroll', 'totalExpenses', 'profit']) total[k] = r2(total[k]);
  for (const c of Object.keys(total.expenseByCat)) total.expenseByCat[c] = r2(total.expenseByCat[c]);
  return { from, to, days: daysBetween(from, to) + 1, payrollIncluded: payroll, currency: getSetting('currency'), categories: CATEGORIES, branches: rows, total };
}

function saveReport(type, start, end) {
  const data = buildReport(start, end, { payroll: true });
  db.prepare(`INSERT INTO reports (type, period_start, period_end, data) VALUES (?,?,?,?)
    ON CONFLICT(type, period_start) DO UPDATE SET data=excluded.data, period_end=excluded.period_end, created_at=CURRENT_TIMESTAMP`)
    .run(type, start, end, JSON.stringify(data));
  return data;
}
function generateMissingReports(force = false) {
  const made = [];
  if (!db.prepare('SELECT 1 FROM daily_sales LIMIT 1').get()) return made;
  const has = (t, s) => !!db.prepare('SELECT 1 FROM reports WHERE type=? AND period_start=?').get(t, s);
  const today = todayStr();
  const w0 = addDays(mondayOf(today), -7);
  for (let i = 0; i < 4; i++) {
    const s = addDays(w0, -7 * i), e = addDays(s, 6), existed = has('weekly', s);
    if (!existed || (force && i === 0)) { const d = saveReport('weekly', s, e); made.push({ type: 'weekly', start: s, end: e, isNew: !existed && i === 0, data: d }); }
  }
  let ms = monthStart(addDays(monthStart(today), -1));
  for (let i = 0; i < 3; i++) {
    const e = monthEnd(ms), existed = has('monthly', ms);
    if (!existed || (force && i === 0)) { const d = saveReport('monthly', ms, e); made.push({ type: 'monthly', start: ms, end: e, isNew: !existed && i === 0, data: d }); }
    ms = monthStart(addDays(ms, -1));
  }
  return made;
}

/* ------------------------------------------------------------------ SMS + expiry alerts */
async function sendSms(to, body) {
  const { TWILIO_SID: sid, TWILIO_TOKEN: tok, TWILIO_FROM: from } = process.env;
  if (!sid || !tok || !from) return { ok: false, error: 'SMS provider is not configured on the server' };
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body })
    });
    if (!r.ok) return { ok: false, error: 'Provider error ' + r.status + ': ' + (await r.text()).slice(0, 160) };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function smsAll(body) {
  const phones = phoneList();
  if (!phones.length) return { ok: false, error: 'No alert phone numbers are set' };
  let ok = false, error = '';
  for (const p of phones) { const r = await sendSms(p, body); if (r.ok) ok = true; else error = r.error; }
  return { ok, error };
}

function getAlerts(maxDays) {
  const today = todayStr(), max = Number.isFinite(maxDays) ? maxDays : Math.max(...thresholds()), out = [];
  const emps = db.prepare(`SELECT e.id, e.name, e.passport_no, e.passport_expiry, e.visa_no, e.visa_expiry, b.name AS branch_name
    FROM employees e LEFT JOIN branches b ON b.id=e.branch_id`).all();
  for (const e of emps) {
    for (const [kind, num, exp] of [['passport', e.passport_no, e.passport_expiry], ['visa', e.visa_no, e.visa_expiry]]) {
      if (!isDate(exp)) continue;
      const days = daysBetween(today, exp);
      if (days <= max) out.push({ emp_id: e.id, name: e.name, branch_name: e.branch_name, kind, number: num, expiry: exp, days, status: days < 0 ? 'expired' : 'soon' });
    }
  }
  return out.sort((a, b) => a.days - b.days);
}
async function runAlertCheck() {
  const th = thresholds(), fresh = [];
  for (const a of getAlerts()) {
    const bucket = a.days < 0 ? 'expired' : String(th.find(t => a.days <= t));
    const key = bucket + '|' + a.expiry;
    if (!db.prepare('SELECT 1 FROM alert_log WHERE emp_id=? AND kind=? AND key=?').get(a.emp_id, a.kind, key)) fresh.push({ ...a, key });
  }
  if (!fresh.length) return { found: 0, sent: false, message: 'No new expiry alerts.' };
  const lines = fresh.map(a => `${a.name}${a.branch_name ? ' (' + a.branch_name + ')' : ''}: ${a.kind} ` +
    (a.days < 0 ? `EXPIRED ${-a.days}d ago` : a.days === 0 ? 'expires TODAY' : `expires in ${a.days}d`) + ` (${a.expiry})`);
  const chunks = []; let cur = 'Restaurant Control alert:';
  for (const l of lines) { if ((cur + '\n' + l).length > 300 && cur !== 'Restaurant Control alert:') { chunks.push(cur); cur = 'Restaurant Control alert:'; } cur += '\n' + l; }
  chunks.push(cur);
  let allOk = true, error = '';
  for (const c of chunks) { const r = await smsAll(c); if (!r.ok) { allOk = false; error = r.error; } }
  if (allOk) { const ins = db.prepare('INSERT OR IGNORE INTO alert_log (emp_id, kind, key) VALUES (?,?,?)'); for (const a of fresh) ins.run(a.emp_id, a.kind, a.key); }
  return { found: fresh.length, sent: allOk, error, message: allOk ? `SMS sent for ${fresh.length} item(s).` : 'SMS not sent: ' + error };
}

async function tick() {
  try {
    const made = generateMissingReports();
    if (getSetting('sms_reports') === '1') {
      for (const m of made.filter(x => x.isNew)) {
        const t = m.data.total, c = m.data.currency;
        await smsAll(`Restaurant Control ${m.type} report ${m.start} to ${m.end}: Income ${c} ${t.income}, Expenses ${c} ${t.totalExpenses}, Profit ${c} ${t.profit}`);
      }
    }
    const today = todayStr();
    if (smsConfigured() && phoneList().length && hourNow() >= 9 && getSetting('last_alert_run') !== today) { setSetting('last_alert_run', today); await runAlertCheck(); }
  } catch (e) { console.error('Scheduler error:', e); }
}

/* ------------------------------------------------------------------ sessions (stored in the same database) */
class SqliteStore extends session.Store {
  constructor() {
    super();
    db.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire INTEGER NOT NULL)');
    setInterval(() => db.prepare('DELETE FROM sessions WHERE expire<?').run(Date.now()), 3600e3).unref();
  }
  get(sid, cb) { try { const r = db.prepare('SELECT sess FROM sessions WHERE sid=? AND expire>?').get(sid, Date.now()); cb(null, r ? JSON.parse(r.sess) : null); } catch (e) { cb(e); } }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 864e5;
      db.prepare('INSERT INTO sessions (sid,sess,expire) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expire=excluded.expire').run(sid, JSON.stringify(sess), exp);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) { try { db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb && cb(null); } catch (e) { cb && cb(e); } }
}

/* ------------------------------------------------------------------ app */
const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));
app.use(session({
  secret: SECRET, store: new SqliteStore(), resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === '1', maxAge: 8 * 60 * 60 * 1000 }
}));
app.use((req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});
// Always use the current role from the database (so changes by the administrator apply immediately)
app.use((req, res, next) => {
  if (req.session && req.session.user) {
    const u = db.prepare('SELECT id, username, role, branch_id FROM users WHERE id=?').get(req.session.user.id);
    if (!u) return req.session.destroy(() => next());
    req.session.user = { id: u.id, username: u.username, role: u.role, branch_id: u.branch_id };
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const role = req => req.session.user && req.session.user.role;
const requireLogin = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Please log in' });
const requireAdmin = (req, res, next) => role(req) === 'admin' ? next() : res.status(403).json({ error: 'Administrator only' });
const requireView = (req, res, next) => ['admin', 'user'].includes(role(req)) ? next() : res.status(403).json({ error: 'Not allowed for your account' });
const requireEntry = (req, res, next) => {
  if (role(req) === 'admin') return next();
  if (role(req) === 'manager' && req.session.user.branch_id) return next();
  res.status(403).json({ error: 'Only the administrator or a branch manager can do this' });
};
const myBranch = req => role(req) === 'manager' ? req.session.user.branch_id : null;
// Branch managers may enter or change figures for today and the previous 14 days only
function dateAllowed(req, date) {
  if (!isDate(date)) return 'Invalid date';
  const t = todayStr();
  if (date > t) return 'You cannot enter figures for a future date';
  if (role(req) !== 'admin' && daysBetween(date, t) > 14) return 'Managers can only change the last 14 days. Ask the administrator.';
  return null;
}
const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? r2(n) : 0; };
const daysParam = req => { const n = parseInt(req.query.days, 10); return Number.isFinite(n) && n >= 0 && n <= 730 ? n : undefined; };
// CSV downloads open directly in Excel (UTF-8 with BOM so Arabic and other names display correctly)
const csvq = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const sendCsv = (res, filename, rows) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
  res.send('\ufeff' + rows.map(r => r.map(csvq).join(',')).join('\r\n'));
};

/* ---- login ---- */
const attempts = new Map();
app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const key = req.ip + '|' + username;
  const a = attempts.get(key);
  if (a && a.count >= 5 && Date.now() - a.last < 15 * 60 * 1000) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const u = db.prepare('SELECT * FROM users WHERE lower(username)=?').get(username);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    attempts.set(key, { count: (a && Date.now() - a.last < 15 * 60 * 1000 ? a.count : 0) + 1, last: Date.now() });
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  attempts.delete(key);
  req.session.regenerate(() => {
    req.session.user = { id: u.id, username: u.username, role: u.role, branch_id: u.branch_id };
    res.json(req.session.user);
  });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => req.session.user ? res.json(req.session.user) : res.status(401).json({ error: 'Not logged in' }));
app.get('/api/config', requireLogin, (req, res) => res.json({
  currency: getSetting('currency'), today: todayStr(), categories: CATEGORIES, smsConfigured: smsConfigured(), timezone: TZ
}));
app.post('/api/me/password', requireLogin, (req, res) => {
  const { current, next } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id);
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) return res.status(400).json({ error: 'Current password is wrong' });
  if (!next || String(next).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(String(next), 10), u.id);
  res.json({ ok: true });
});

/* ---- branches ---- */
app.get('/api/branches', requireLogin, (req, res) => {
  const all = db.prepare(`SELECT b.id, b.name, COUNT(e.id) AS employees FROM branches b
    LEFT JOIN employees e ON e.branch_id=b.id GROUP BY b.id ORDER BY b.id`).all();
  const mine = myBranch(req);
  res.json(role(req) === 'manager' ? all.filter(b => b.id === mine).map(b => ({ ...b, employees: 0 })) : all);
});
app.post('/api/branches', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Branch name required' });
  try { res.json({ id: db.prepare('INSERT INTO branches (name) VALUES (?)').run(name).lastInsertRowid }); }
  catch { res.status(400).json({ error: 'Branch name already exists' }); }
});
app.put('/api/branches/:id', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Branch name required' });
  try { db.prepare('UPDATE branches SET name=? WHERE id=?').run(name, req.params.id); res.json({ ok: true }); }
  catch { res.status(400).json({ error: 'Branch name already exists' }); }
});

/* ---- employees (administrator and read-only users; branch managers have no access) ---- */
const FIELDS = ['emp_code', 'name', 'job_title', 'phone', 'email', 'nationality', 'branch_id', 'work_location',
  'salary', 'passport_no', 'passport_expiry', 'visa_type', 'visa_no', 'visa_expiry', 'notes'];
function clean(body) {
  const o = {};
  for (const f of FIELDS) {
    let v = body[f];
    if (v === undefined || v === null || v === '') v = null;
    else if (f === 'salary') { v = Number(v); if (Number.isNaN(v)) v = null; }
    else if (f === 'branch_id') v = Number(v) || null;
    else v = String(v).trim();
    o[f] = v;
  }
  return o;
}
app.get('/api/employees', requireView, (req, res) => {
  const q = '%' + String(req.query.q || '').trim() + '%';
  const branch = Number(req.query.branch) || null;
  res.json(db.prepare(`SELECT e.*, b.name AS branch_name FROM employees e
    LEFT JOIN branches b ON b.id=e.branch_id
    WHERE (e.name LIKE ? OR e.emp_code LIKE ? OR e.passport_no LIKE ?) AND (? IS NULL OR e.branch_id=?)
    ORDER BY e.name COLLATE NOCASE LIMIT 600`).all(q, q, q, branch, branch));
});
app.get('/api/employees/csv', requireView, (req, res) => {
  const rows = db.prepare(`SELECT e.*, b.name AS branch_name FROM employees e LEFT JOIN branches b ON b.id=e.branch_id
    ORDER BY b.id, e.name COLLATE NOCASE`).all();
  sendCsv(res, 'restaurant-control-employees-' + todayStr() + '.csv', [
    ['Employee code', 'Name', 'Job title', 'Phone', 'Email', 'Nationality', 'Branch', 'Work location', 'Monthly salary', 'Passport no.', 'Passport expiry', 'Visa type', 'Visa no.', 'Visa expiry', 'Notes'],
    ...rows.map(e => [e.emp_code, e.name, e.job_title, e.phone, e.email, e.nationality, e.branch_name, e.work_location, e.salary, e.passport_no, e.passport_expiry, e.visa_type, e.visa_no, e.visa_expiry, e.notes])
  ]);
});
app.get('/api/employees/:id', requireView, (req, res) => {
  const r = db.prepare(`SELECT e.*, b.name AS branch_name FROM employees e LEFT JOIN branches b ON b.id=e.branch_id WHERE e.id=?`).get(req.params.id);
  r ? res.json(r) : res.status(404).json({ error: 'Not found' });
});
app.post('/api/employees', requireAdmin, (req, res) => {
  const o = clean(req.body);
  if (!o.name) return res.status(400).json({ error: 'Name is required' });
  const info = db.prepare(`INSERT INTO employees (${FIELDS.join(',')}) VALUES (${FIELDS.map(f => '@' + f).join(',')})`).run(o);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/employees/:id', requireAdmin, (req, res) => {
  const o = clean(req.body);
  if (!o.name) return res.status(400).json({ error: 'Name is required' });
  db.prepare(`UPDATE employees SET ${FIELDS.map(f => f + '=@' + f).join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=@id`).run({ ...o, id: Number(req.params.id) });
  res.json({ ok: true });
});
app.delete('/api/employees/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM employees WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

/* ---- daily sales ---- */
app.get('/api/sales', requireLogin, (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : todayStr();
  const mine = myBranch(req);
  if (role(req) === 'manager' && !mine) return res.json([]);
  res.json(db.prepare(`SELECT * FROM daily_sales WHERE date=?${mine ? ' AND branch_id=?' : ''}`).all(...(mine ? [date, mine] : [date])));
});
app.post('/api/sales/bulk', requireEntry, (req, res) => {
  const date = String(req.body.date || '');
  const bad = dateAllowed(req, date);
  if (bad) return res.status(400).json({ error: bad });
  const mine = myBranch(req);
  const valid = new Set(db.prepare('SELECT id FROM branches').all().map(b => b.id));
  const up = db.prepare(`INSERT INTO daily_sales (branch_id, date, cash, card, delivery, other, notes, updated_by, updated_at)
    VALUES (@branch_id,@date,@cash,@card,@delivery,@other,@notes,@by,CURRENT_TIMESTAMP)
    ON CONFLICT(branch_id,date) DO UPDATE SET cash=@cash, card=@card, delivery=@delivery, other=@other, notes=@notes, updated_by=@by, updated_at=CURRENT_TIMESTAMP`);
  const exists = db.prepare('SELECT 1 FROM daily_sales WHERE branch_id=? AND date=?');
  let saved = 0;
  for (const r of Array.isArray(req.body.rows) ? req.body.rows : []) {
    const bid = Number(r.branch_id);
    if (!valid.has(bid) || (mine && bid !== mine)) continue;
    const row = { branch_id: bid, date, cash: num(r.cash), card: num(r.card), delivery: num(r.delivery), other: num(r.other), notes: String(r.notes || '').trim().slice(0, 300) || null, by: req.session.user.username };
    if (!row.cash && !row.card && !row.delivery && !row.other && !row.notes && !exists.get(bid, date)) continue;
    up.run(row); saved++;
  }
  res.json({ ok: true, saved });
});

/* ---- expenses ---- */
app.get('/api/expenses', requireLogin, (req, res) => {
  const t = todayStr();
  const from = isDate(req.query.from) ? req.query.from : monthStart(t);
  const to = isDate(req.query.to) ? req.query.to : t;
  const branch = myBranch(req) || Number(req.query.branch) || null;
  if (role(req) === 'manager' && !branch) return res.json([]);
  res.json(db.prepare(`SELECT x.*, b.name AS branch_name FROM expenses x JOIN branches b ON b.id=x.branch_id
    WHERE x.date BETWEEN ? AND ? AND (? IS NULL OR x.branch_id=?) ORDER BY x.date DESC, x.id DESC LIMIT 1000`).all(from, to, branch, branch));
});
app.post('/api/expenses', requireEntry, (req, res) => {
  const b = req.body;
  const bad = dateAllowed(req, String(b.date || ''));
  if (bad) return res.status(400).json({ error: bad });
  const branch = myBranch(req) || Number(b.branch_id);
  if (!db.prepare('SELECT 1 FROM branches WHERE id=?').get(branch)) return res.status(400).json({ error: 'Choose a branch' });
  const category = CATEGORIES.includes(b.category) ? b.category : null;
  if (!category) return res.status(400).json({ error: 'Choose a category' });
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter an amount greater than zero' });
  const info = db.prepare('INSERT INTO expenses (branch_id, date, category, amount, description, created_by) VALUES (?,?,?,?,?,?)')
    .run(branch, b.date, category, r2(amount), String(b.description || '').trim().slice(0, 300) || null, req.session.user.username);
  res.json({ id: info.lastInsertRowid });
});
app.delete('/api/expenses/:id', requireEntry, (req, res) => {
  const e = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const mine = myBranch(req);
  if (mine && e.branch_id !== mine) return res.status(403).json({ error: 'Not your branch' });
  const bad = dateAllowed(req, e.date);
  if (bad) return res.status(400).json({ error: bad });
  db.prepare('DELETE FROM expenses WHERE id=?').run(e.id);
  res.json({ ok: true });
});

/* ---- reports ---- */
function liveReport(req) {
  const t = todayStr();
  const from = isDate(req.query.from) ? req.query.from : monthStart(t);
  const to = isDate(req.query.to) ? req.query.to : t;
  if (from > to) return { error: 'The start date is after the end date' };
  if (daysBetween(from, to) > 400) return { error: 'Please choose a period of 13 months or less' };
  const mgr = role(req) === 'manager';
  if (mgr && !req.session.user.branch_id) return { error: 'No branch is assigned to your account' };
  return { data: buildReport(from, to, { branchId: mgr ? req.session.user.branch_id : (Number(req.query.branch) || null), payroll: !mgr }) };
}
app.get('/api/reports/live', requireLogin, (req, res) => {
  const r = liveReport(req);
  r.error ? res.status(400).json({ error: r.error }) : res.json(r.data);
});
function reportRows(d) {
  const cats = d.categories;
  const line = b => [b.name, b.cash, b.card, b.delivery, b.other, b.income, ...cats.map(c => b.expenseByCat[c] || 0), b.expenses, b.payroll, b.totalExpenses, b.profit];
  return [
    ['Restaurant Control report ' + d.from + ' to ' + d.to + ' (' + d.currency + ')' + (d.payrollIncluded ? '' : ' - payroll not included')],
    ['Branch', 'Cash', 'Card', 'Delivery', 'Other', 'Total income', ...cats, 'Operating expenses', 'Payroll', 'Total expenses', 'Profit'],
    ...d.branches.map(line), line(d.total)
  ];
}
app.get('/api/reports/csv', requireLogin, (req, res) => {
  const r = liveReport(req);
  if (r.error) return res.status(400).json({ error: r.error });
  sendCsv(res, `restaurant-control-report-${r.data.from}_to_${r.data.to}.csv`, reportRows(r.data));
});
app.get('/api/reports/saved', requireView, (req, res) => {
  res.json(db.prepare('SELECT id, type, period_start, period_end, created_at FROM reports ORDER BY period_start DESC, type').all());
});
app.get('/api/reports/saved/:id', requireView, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  r ? res.json({ type: r.type, created_at: r.created_at, ...JSON.parse(r.data) }) : res.status(404).json({ error: 'Not found' });
});
app.get('/api/reports/saved/:id/csv', requireView, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  sendCsv(res, `restaurant-control-${r.type}-${r.period_start}_to_${r.period_end}.csv`, reportRows(JSON.parse(r.data)));
});
app.post('/api/reports/run', requireAdmin, (req, res) => {
  const made = generateMissingReports(true);
  res.json({ ok: true, generated: made.map(m => ({ type: m.type, start: m.start, end: m.end })) });
});

/* ---- dashboard ---- */
app.get('/api/dashboard', requireLogin, (req, res) => {
  const mgr = role(req) === 'manager', bid = myBranch(req);
  if (mgr && !bid) return res.json({ noBranch: true });
  const today = todayStr(), ms = monthStart(today);
  const mtd = buildReport(ms, today, { branchId: bid, payroll: !mgr });
  const sc = bid ? ' AND branch_id=?' : '';
  const sum = (a, b) => db.prepare(`SELECT COALESCE(SUM(cash+card+delivery+other),0) v FROM daily_sales WHERE date BETWEEN ? AND ?${sc}`).get(...(bid ? [a, b, bid] : [a, b])).v;
  const byDate = Object.fromEntries(db.prepare(`SELECT date, SUM(cash+card+delivery+other) v FROM daily_sales WHERE date BETWEEN ? AND ?${sc} GROUP BY date`)
    .all(...(bid ? [addDays(today, -13), today, bid] : [addDays(today, -13), today])).map(r => [r.date, r.v]));
  const last14 = []; for (let i = 13; i >= 0; i--) { const d = addDays(today, -i); last14.push({ date: d, income: r2(byDate[d] || 0) }); }
  const out = {
    today, currency: getSetting('currency'), role: role(req),
    todaySales: r2(sum(today, today)), yesterdaySales: r2(sum(addDays(today, -1), addDays(today, -1))),
    mtd: { income: mtd.total.income, expenses: mtd.total.totalExpenses, profit: mtd.total.profit, payrollIncluded: mtd.payrollIncluded },
    last14, topBranches: [...mtd.branches].sort((a, b) => b.income - a.income).slice(0, 8).map(b => ({ name: b.name, income: b.income, profit: b.profit }))
  };
  if (!mgr) {
    out.missingToday = db.prepare('SELECT name FROM branches WHERE id NOT IN (SELECT branch_id FROM daily_sales WHERE date=?) ORDER BY id').all(today).map(b => b.name);
    const al = getAlerts();
    out.alerts = { expired: al.filter(a => a.status === 'expired').length, soon: al.filter(a => a.status === 'soon').length };
  } else {
    out.missingToday = db.prepare('SELECT 1 FROM daily_sales WHERE date=? AND branch_id=?').get(today, bid) ? [] : ['Your branch']
  }
  res.json(out);
});

/* ---- alerts + settings ---- */
app.get('/api/alerts', requireView, (req, res) => res.json({
  items: getAlerts(daysParam(req)), thresholds: thresholds(), smsConfigured: smsConfigured(),
  settings: role(req) === 'admin' ? { currency: getSetting('currency'), alert_phones: getSetting('alert_phones'), alert_days: getSetting('alert_days'), sms_reports: getSetting('sms_reports') } : undefined
}));
app.get('/api/alerts/csv', requireView, (req, res) => {
  sendCsv(res, 'restaurant-control-passport-visa-' + todayStr() + '.csv', [
    ['Employee', 'Branch', 'Document', 'Number', 'Expiry date', 'Days left', 'Status'],
    ...getAlerts(daysParam(req)).map(a => [a.name, a.branch_name, a.kind === 'visa' ? 'Visa' : 'Passport', a.number, a.expiry, a.days, a.days < 0 ? 'EXPIRED' : 'Expiring soon'])
  ]);
});
app.put('/api/settings', requireAdmin, (req, res) => {
  const b = req.body;
  if (b.currency !== undefined) setSetting('currency', String(b.currency).trim().slice(0, 8) || 'AED');
  if (b.alert_phones !== undefined) {
    const phones = String(b.alert_phones).split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
    if (phones.some(p => !/^\+\d{8,15}$/.test(p))) return res.status(400).json({ error: 'Phone numbers must be in international format, like +971501234567' });
    setSetting('alert_phones', phones.join(', '));
  }
  if (b.alert_days !== undefined) {
    const t = String(b.alert_days).split(/[,\s;]+/).filter(Boolean).map(Number);
    if (!t.length || t.some(n => !Number.isInteger(n) || n < 0 || n > 365)) return res.status(400).json({ error: 'Alert days must be numbers like 60, 30, 7' });
    setSetting('alert_days', t.join(','));
  }
  if (b.sms_reports !== undefined) setSetting('sms_reports', b.sms_reports ? '1' : '0');
  res.json({ ok: true });
});
app.post('/api/alerts/run', requireAdmin, async (req, res) => res.json(await runAlertCheck()));
app.post('/api/alerts/test', requireAdmin, async (req, res) => {
  const r = await smsAll('Restaurant Control: this is a test message. SMS alerts are working.');
  res.json(r.ok ? { ok: true, message: 'Test SMS sent.' } : { ok: false, message: 'Test failed: ' + r.error });
});

/* ---- users (administrator only) ---- */
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT u.id, u.username, u.role, u.branch_id, b.name AS branch_name, u.created_at
    FROM users u LEFT JOIN branches b ON b.id=u.branch_id ORDER BY u.username`).all());
});
app.post('/api/users', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const r = ['admin', 'manager'].includes(req.body.role) ? req.body.role : 'user';
  const branch = r === 'manager' ? Number(req.body.branch_id) || null : null;
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (r === 'manager' && !db.prepare('SELECT 1 FROM branches WHERE id=?').get(branch)) return res.status(400).json({ error: 'Choose the branch this manager looks after' });
  try {
    db.prepare('INSERT INTO users (username, password_hash, role, branch_id) VALUES (?,?,?,?)').run(username, bcrypt.hashSync(password, 10), r, branch);
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Username already exists' }); }
});
app.put('/api/users/:id/password', requireAdmin, (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Restaurant Control running on http://localhost:' + PORT);
  setInterval(tick, 10 * 60 * 1000);
  setTimeout(tick, 5000);
});
