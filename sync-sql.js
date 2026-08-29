/* ============================================================
   KanBarcode — ตัวดึงข้อมูลอัตโนมัติ  SQL Server → Supabase
   ------------------------------------------------------------
   รันบนคอมเครื่องไหนก็ได้ในออฟฟิศที่เปิด Excel ต่อ SQL Server ได้อยู่แล้ว
   ไม่ต้องติดตั้งหรือแก้อะไรที่เครื่อง SQL Server

   ทุกกี่นาทีตามที่ตั้งไว้ จะ
     1) อ่านข้อมูลจาก View/Table ที่ระบุ
     2) จับคู่ชื่อคอลัมน์ให้เป็นรูปแบบของระบบ (เหมือนหน้าเว็บ)
     3) ส่งขึ้น Supabase — เอกสารใหม่เพิ่มให้ ของเดิมอัปเดตเฉพาะรายละเอียด

   ⚠ ของเดิมจะไม่ถูกทับ "สถานะ" และ "รถที่ผูกไว้" เด็ดขาด
     เพราะสองอย่างนั้นมาจากการยิงบาร์โค้ดหน้างาน ไม่ได้มาจาก SQL Server
     และไม่มีการลบเอกสารทิ้ง แม้แถวนั้นจะหายไปจาก View แล้วก็ตาม

   วิธีใช้
     1) npm install                 (ครั้งแรกครั้งเดียว)
     2) node sync-sql.js --pick     ← ตั้งค่าแบบเลือกจากรายการจริงบนเซิร์ฟเวอร์
                                      (เลือกฐานข้อมูล → เลือก Table/View → จับคู่คอลัมน์)
                                      หรือดับเบิลคลิก sync-pick.bat
        node sync-sql.js --list     ← แค่ดูรายชื่อฐานข้อมูลกับ View เฉย ๆ
     3) node sync-sql.js --once     ← ลองยิงรอบเดียวดูก่อน
        node sync-sql.js            ← รันค้างไว้ ดึงซ้ำตามรอบที่ตั้ง
        หรือดับเบิลคลิก sync-start.bat
     (จะแก้ sync-config.json ด้วยมือเองก็ได้ ดูแม่แบบที่ sync-config.example.json)
   ============================================================ */
const fs = require('fs');
const path = require('path');
const sql = require('mssql');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'sync-config.json');
const STATE_FILE = path.join(ROOT, '.sync-state.json');
const LOG_FILE = path.join(ROOT, 'sync-sql.log');
const ONCE = process.argv.includes('--once');
const PICK = process.argv.includes('--pick') || process.argv.includes('--setup');
const LIST = process.argv.includes('--list');
const CHUNK = 400;

/* ---------------- log ---------------- */
function log(msg) {
  const t = new Date();
  const stamp = t.getFullYear() + '-' + p2(t.getMonth() + 1) + '-' + p2(t.getDate()) +
    ' ' + p2(t.getHours()) + ':' + p2(t.getMinutes()) + ':' + p2(t.getSeconds());
  const line = stamp + '  ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\r\n', 'utf8'); } catch (e) { /* เขียน log ไม่ได้ก็ไม่เป็นไร */ }
}
function p2(n) { return String(n).padStart(2, '0'); }

/* ---------------- config ---------------- */
function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return;
    const v = m[2].trim().replace(/^["']|["']$/g, '');
    if (v && process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
}
/* อ่าน config เท่าที่มี ไม่บ่นถ้ายังไม่ครบ — ใช้ตอนตั้งค่าด้วย --pick */
function loadConfigLoose() {
  loadEnvLocal();
  let cfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
    catch (e) { log('sync-config.json ไม่ใช่ JSON ที่ถูกต้อง: ' + e.message); process.exit(1); }
  }
  cfg.sql = cfg.sql || {};
  cfg.supabase = cfg.supabase || {};
  cfg.supabase.url = cfg.supabase.url || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  cfg.supabase.key = cfg.supabase.key || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  cfg.supabase.email = cfg.supabase.email || process.env.SYNC_EMAIL || '';
  cfg.supabase.password = cfg.supabase.password || process.env.SYNC_PASSWORD || '';
  cfg.supabase.serviceKey = cfg.supabase.serviceKey || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  cfg.everyMinutes = Number(cfg.everyMinutes) || 30;
  cfg.jobs = Array.isArray(cfg.jobs) ? cfg.jobs : [];
  return cfg;
}
function saveConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2), 'utf8');
}
function loadConfig() {
  loadEnvLocal();
  if (!fs.existsSync(CONFIG_FILE)) {
    log('ไม่พบไฟล์ sync-config.json — สั่ง  node sync-sql.js --pick  เพื่อตั้งค่าแบบเลือกจากรายการ');
    process.exit(1);
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { log('sync-config.json ไม่ใช่ JSON ที่ถูกต้อง: ' + e.message); process.exit(1); }

  cfg.supabase = cfg.supabase || {};
  cfg.supabase.url = cfg.supabase.url || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  cfg.supabase.key = cfg.supabase.key || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  cfg.supabase.email = cfg.supabase.email || process.env.SYNC_EMAIL || '';
  cfg.supabase.password = cfg.supabase.password || process.env.SYNC_PASSWORD || '';
  cfg.supabase.serviceKey = cfg.supabase.serviceKey || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  cfg.everyMinutes = Number(cfg.everyMinutes) || 30;
  cfg.jobs = (cfg.jobs || []).filter(j => j && j.enabled !== false);

  const miss = [];
  if (!cfg.sql || !cfg.sql.server) miss.push('sql.server');
  if (!cfg.supabase.url) miss.push('supabase.url');
  if (!cfg.supabase.key) miss.push('supabase.key (anon/publishable key)');
  if (!cfg.supabase.serviceKey && !(cfg.supabase.email && cfg.supabase.password))
    miss.push('supabase.email + supabase.password (บัญชีที่ใช้เขียนข้อมูล)');
  if (!cfg.jobs.length) miss.push('jobs (ยังไม่ได้เปิดใช้งานงานไหนเลย)');
  if (miss.length) { log('sync-config.json ยังขาดค่า: ' + miss.join(', ')); process.exit(1); }
  return cfg;
}

/* ---------------- จับคู่ชื่อคอลัมน์ (ชุดเดียวกับหน้าเว็บ) ---------------- */
const MAPS = {
  documents: {
    table: 'documents', pk: 'doc_no',
    map: {
      row: ['แถว', 'ลำดับ', 'ที่', 'no', 'row', 'seq'],
      docNo: ['เลขที่เอกสาร', 'เลขทีเอกสาร', 'docno', 'doc_no', 'document', 'documentno', 'invoice', 'เลขที่บิล'],
      docDate: ['วันที่เอกสาร', 'วันที่', 'docdate', 'doc_date', 'date'],
      custCode: ['รหัสลูกค้า', 'custcode', 'cust_code', 'customercode', 'code'],
      custName: ['ชื่อลูกค้า', 'custname', 'cust_name', 'customername', 'customer', 'name'],
      address: ['ที่อยู่', 'address', 'addr'],
      tambon: ['ตำบล', 'แขวง', 'tambon', 'subdistrict'],
      amphoe: ['อำเภอ', 'เขต', 'amphoe', 'amphur', 'district'],
      province: ['จังหวัด', 'province', 'changwat']
    },
    need: ['docNo']
  },
  vehicles: {
    table: 'vehicles', pk: 'id',
    map: {
      id: ['รหัสรถ', 'รหัส', 'vehicleid', 'vehicle_id', 'vehiclecode', 'carid', 'carcode', 'id', 'code'],
      brand: ['ยี่ห้อ', 'brand', 'make'],
      model: ['รุ่น', 'model'],
      plate: ['ทะเบียน', 'เลขทะเบียน', 'ทะเบียนรถ', 'plate', 'licenseplate', 'license', 'regno', 'registration'],
      driver: ['คนขับ', 'ชื่อคนขับ', 'พนักงานขับรถ', 'driver', 'drivername'],
      phone: ['เบอร์โทร', 'โทรศัพท์', 'เบอร์', 'phone', 'tel', 'mobile', 'telephone'],
      type: ['ประเภทรถ', 'ประเภท', 'ชนิดรถ', 'type', 'vehicletype', 'cartype'],
      capacity: ['น้ำหนักบรรทุก', 'บรรทุก', 'ความจุ', 'capacity', 'load', 'payload'],
      note: ['หมายเหตุ', 'note', 'remark', 'description']
    },
    need: ['id']
  }
};
function norm(h) { return String(h == null ? '' : h).trim().toLowerCase().replace(/\s+/g, ''); }
function mapWith(m, h) {
  const k = norm(h);
  for (const f in m) if (m[f].some(x => norm(x) === k)) return f;
  return null;
}
/* จับคู่หัวคอลัมน์ทั้งชุด โดยให้ค่าที่ผู้ใช้กำหนดเองใน config มาก่อน */
function buildHeadMap(job, columns) {
  const m = MAPS[job.target].map, out = {};
  const manual = job.columns || {};           /* {"docNo":"DI_REF"} */
  for (const f in manual) {
    const col = columns.find(c => norm(c) === norm(manual[f]));
    if (col) out[col] = f;
  }
  columns.forEach(c => {
    if (out[c]) return;
    const f = mapWith(m, c);
    if (f && !Object.values(out).includes(f)) out[c] = f;
  });
  return out;
}
function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function normDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isoDate(v);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) { let y = Number(m[3]); if (y > 2400) y -= 543; return y + '-' + pad(m[2]) + '-' + pad(m[1]); }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : isoDate(d);
}
function str(v) { return v == null ? '' : String(v).trim(); }

/* ---------------- SQL Server ---------------- */
function sqlConfig(c) {
  let host = String(c.server).trim(), instanceName;
  const BS = String.fromCharCode(92);
  if (host.includes(BS)) { const p = host.split(BS); host = p[0]; instanceName = p[1]; }
  if (host.includes(',')) host = host.split(',')[0];

  const conf = {
    server: host,
    port: parseInt(c.port, 10) || 1433,
    database: String(c.database || '').trim(),
    options: {
      encrypt: c.encrypt !== false,
      trustServerCertificate: true,
      enableArithAbort: true,
      ...(instanceName ? { instanceName } : {})
    },
    connectionTimeout: 15000,
    requestTimeout: 120000,
    pool: { max: 2, min: 0, idleTimeoutMillis: 10000 }
  };
  /* ล็อกอินแบบ Windows (โดเมน) — ใช้ตอนที่ SQL Server ไม่ได้เปิด SQL Authentication ไว้ */
  if (String(c.auth || 'sql').toLowerCase() === 'ntlm') {
    conf.authentication = {
      type: 'ntlm',
      options: { userName: c.user, password: c.password, domain: c.domain || '' }
    };
  } else {
    conf.user = c.user;
    conf.password = c.password;
  }
  return conf;
}
async function readSql(cfg, job) {
  const c = Object.assign({}, cfg.sql, job.sql || {});
  if (!c.database) throw new Error('งาน "' + job.name + '" ยังไม่ได้ระบุ database');
  const pool = await new sql.ConnectionPool(sqlConfig(c)).connect();
  try {
    const q = job.query || ('SELECT TOP ' + (Number(job.top) || 5000) + ' * FROM ' + safeName(job.view));
    const r = await pool.request().query(q);
    const columns = r.recordset && r.recordset.columns
      ? Object.keys(r.recordset.columns)
      : (r.recordset[0] ? Object.keys(r.recordset[0]) : []);
    return { columns, rows: r.recordset };
  } finally {
    try { await pool.close(); } catch (e) { /* ปิดไม่ได้ก็ปล่อย */ }
  }
}
function safeName(v) {
  const s = String(v || '').trim().replace(/[\[\]]/g, '');
  if (!s) throw new Error('ยังไม่ได้ระบุ view หรือ query ในงานนี้');
  const parts = s.split('.');
  if (parts.length > 3) throw new Error('ชื่อ View/Table ไม่ถูกต้อง: ' + v);
  for (const p of parts) {
    if (!/^[A-Za-z_฀-๿][A-Za-z0-9_฀-๿$#@ ]*$/.test(p))
      throw new Error('ชื่อ View/Table ไม่ถูกต้อง: ' + v);
  }
  return parts.map(p => '[' + p + ']').join('.');
}

/* ---------------- Supabase (REST) ---------------- */
let TOKEN = null;
async function sbLogin(cfg) {
  if (cfg.supabase.serviceKey) { TOKEN = cfg.supabase.serviceKey; return 'service key'; }
  const r = await fetch(cfg.supabase.url + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: cfg.supabase.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: cfg.supabase.email, password: cfg.supabase.password })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error('ล็อกอิน Supabase ไม่สำเร็จ: ' + (j.error_description || j.msg || j.error || ('HTTP ' + r.status)));
  }
  TOKEN = j.access_token;
  return cfg.supabase.email;
}
function sbHeaders(cfg, extra) {
  return Object.assign({
    apikey: cfg.supabase.key,
    Authorization: 'Bearer ' + TOKEN,
    'Content-Type': 'application/json'
  }, extra || {});
}
async function sbSelectKeys(cfg, table, pk) {
  const keys = new Set();
  const step = 1000;
  for (let from = 0; ; from += step) {
    const r = await fetch(cfg.supabase.url + '/rest/v1/' + table + '?select=' + pk, {
      headers: sbHeaders(cfg, { Range: from + '-' + (from + step - 1) })
    });
    if (!r.ok) throw new Error('อ่านตาราง ' + table + ' ไม่สำเร็จ: ' + (await r.text()));
    const rows = await r.json();
    rows.forEach(x => keys.add(String(x[pk])));
    if (rows.length < step) break;
  }
  return keys;
}
async function sbUpsert(cfg, table, rows, pk) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const r = await fetch(cfg.supabase.url + '/rest/v1/' + table + '?on_conflict=' + pk, {
      method: 'POST',
      headers: sbHeaders(cfg, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(part)
    });
    if (!r.ok) throw new Error('ส่งขึ้นตาราง ' + table + ' ไม่สำเร็จ: ' + (await r.text()));
  }
}

/* ---------------- state (ส่งเฉพาะแถวที่เปลี่ยน) ---------------- */
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(st) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(st), 'utf8'); }
  catch (e) { log('เขียนไฟล์สถานะไม่สำเร็จ: ' + e.message); }
}

/* ---------------- แปลงแถว ---------------- */
function toDocRow(o) {
  return {
    doc_no: str(o.docNo),
    row_no: o.row === undefined || o.row === '' || o.row === null ? null : (Number(o.row) || null),
    doc_date: normDate(o.docDate),
    cust_code: str(o.custCode) || null,
    cust_name: str(o.custName) || null,
    address: str(o.address) || null,
    tambon: str(o.tambon) || null,
    amphoe: str(o.amphoe) || null,
    province: str(o.province) || null
  };
}
function toVehRow(o) {
  return {
    id: str(o.id) || str(o.plate),
    brand: str(o.brand) || null, model: str(o.model) || null, plate: str(o.plate) || null,
    driver: str(o.driver) || null, phone: str(o.phone) || null, type: str(o.type) || null,
    capacity: str(o.capacity) || null, note: str(o.note) || null
  };
}

/* ---------------- โหมดเลือก View เอง (--pick) / ดูรายการ (--list) ----------------
   ต่อเข้า SQL Server แล้วให้เลือกจากรายการจริงบนเซิร์ฟเวอร์ ไม่ต้องพิมพ์ชื่อเอง
   เลือกเสร็จเขียนลง sync-config.json ให้เลย */
const readline = require('readline');

function ask(rl, q, dflt) {
  const hint = (dflt !== undefined && dflt !== '') ? ' [' + dflt + ']' : '';
  return new Promise(res => rl.question(q + hint + ': ', a => {
    a = String(a || '').trim();
    res(a === '' && dflt !== undefined ? String(dflt) : a);
  }));
}
async function askPick(rl, title, items, dfltIndex) {
  console.log('');
  console.log(title);
  items.forEach((it, i) => console.log('  ' + String(i + 1).padStart(3, ' ') + ') ' + it));
  for (;;) {
    const a = await ask(rl, 'เลือกหมายเลข', dfltIndex ? String(dfltIndex) : undefined);
    const n = parseInt(a, 10);
    if (n >= 1 && n <= items.length) return n - 1;
    console.log('  ** ใส่หมายเลขระหว่าง 1 ถึง ' + items.length + ' **');
  }
}
async function withPool(c, fn) {
  const pool = await new sql.ConnectionPool(sqlConfig(c)).connect();
  try { return await fn(pool); }
  finally { try { await pool.close(); } catch (e) { /* ปิดไม่ได้ก็ปล่อย */ } }
}
async function listDatabases(c) {
  return withPool(Object.assign({}, c, { database: 'master' }), async pool => {
    const r = await pool.request().query(
      'SELECT name, CASE WHEN database_id <= 4 THEN 1 ELSE 0 END AS is_system ' +
      'FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY is_system, name');
    return r.recordset.map(x => ({ name: x.name, system: !!x.is_system }));
  });
}
async function listObjects(c) {
  return withPool(c, async pool => {
    const r = await pool.request().query(
      "SELECT s.name AS [schema], o.name AS [name], " +
      "CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'TABLE' END AS [type] " +
      'FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id ' +
      "WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0 ORDER BY [type], s.name, o.name");
    return r.recordset;
  });
}
async function peek(c, view) {
  return withPool(c, async pool => {
    const r = await pool.request().query('SELECT TOP 5 * FROM ' + safeName(view));
    const columns = r.recordset && r.recordset.columns
      ? Object.keys(r.recordset.columns)
      : (r.recordset[0] ? Object.keys(r.recordset[0]) : []);
    return { columns, rows: r.recordset };
  });
}

async function runList() {
  const cfg = loadConfigLoose();
  if (!cfg.sql.server) { log('ยังไม่ได้ตั้ง sql.server ใน sync-config.json — สั่ง --pick เพื่อตั้งค่า'); process.exit(1); }
  const dbs = await listDatabases(cfg.sql);
  console.log('');
  console.log('ฐานข้อมูลบน ' + cfg.sql.server);
  dbs.forEach(d => console.log('  - ' + d.name + (d.system ? '  (ระบบ)' : '')));
  if (cfg.sql.database) {
    const objs = await listObjects(cfg.sql);
    console.log('');
    console.log('Table / View ใน ' + cfg.sql.database);
    objs.forEach(o => console.log('  - [' + (o.type === 'VIEW' ? 'View ' : 'Table') + '] ' + o.schema + '.' + o.name));
  }
}

async function runPick() {
  const cfg = loadConfigLoose();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('');
    console.log('=== ตั้งค่าตัวดึงข้อมูลอัตโนมัติ — เลือก View เองจากรายการจริงบนเซิร์ฟเวอร์ ===');
    console.log('(กด Enter เพื่อใช้ค่าในวงเล็บ)');
    console.log('');

    /* ---- 1) ค่าเชื่อมต่อ SQL Server ---- */
    cfg.sql.server = await ask(rl, 'Server / DSN', cfg.sql.server || 'bcs-server');
    cfg.sql.port = await ask(rl, 'Port', cfg.sql.port || '1433');
    const authAns = await ask(rl, 'วิธีล็อกอิน  1) SQL Server (กรอกรหัส)  2) Windows (NTLM)',
      String(cfg.sql.auth || 'sql').toLowerCase() === 'ntlm' ? '2' : '1');
    cfg.sql.auth = authAns === '2' ? 'ntlm' : 'sql';
    if (cfg.sql.auth === 'ntlm') cfg.sql.domain = await ask(rl, 'Domain', cfg.sql.domain || '');
    cfg.sql.user = await ask(rl, 'Username', cfg.sql.user || 'sa');
    cfg.sql.password = await ask(rl, 'Password', cfg.sql.password || '');

    /* ---- 2) เลือกฐานข้อมูล ---- */
    console.log('');
    console.log('กำลังอ่านรายชื่อฐานข้อมูลจาก ' + cfg.sql.server + ' ...');
    const dbs = await listDatabases(cfg.sql);
    if (!dbs.length) throw new Error('บัญชีนี้ยังไม่เห็นฐานข้อมูลใดเลย');
    const dbIdx = dbs.findIndex(d => d.name === cfg.sql.database);
    const di = await askPick(rl, 'เลือกฐานข้อมูล',
      dbs.map(d => d.name + (d.system ? '  (ระบบ)' : '')), dbIdx >= 0 ? dbIdx + 1 : undefined);
    cfg.sql.database = dbs[di].name;

    /* ---- 3) เลือกปลายทาง ---- */
    const targets = ['documents', 'vehicles'];
    const ti = await askPick(rl, 'จะนำเข้าไปที่หน้าไหน',
      ['ข้อมูลเอกสาร (documents)', 'รถและคนขับ (vehicles)'], 1);
    const target = targets[ti];

    /* ---- 4) เลือก Table / View ---- */
    console.log('');
    console.log('กำลังอ่านรายชื่อ Table / View ใน ' + cfg.sql.database + ' ...');
    let objs = await listObjects(cfg.sql);
    if (!objs.length) throw new Error('ไม่พบ Table หรือ View ในฐานข้อมูลนี้');
    if (objs.length > 40) {
      const kw = await ask(rl, 'มี ' + objs.length + ' รายการ — พิมพ์คำค้นเพื่อกรอง (Enter = ดูทั้งหมด)', '');
      if (kw) {
        const f = objs.filter(o => (o.schema + '.' + o.name).toLowerCase().indexOf(kw.toLowerCase()) > -1);
        if (f.length) objs = f; else console.log('  ** ไม่พบตามคำค้น แสดงทั้งหมดแทน **');
      }
    }
    const oi = await askPick(rl, 'เลือก Table หรือ View ที่จะดึง',
      objs.map(o => '[' + (o.type === 'VIEW' ? 'View ' : 'Table') + '] ' + o.schema + '.' + o.name));
    const view = objs[oi].schema + '.' + objs[oi].name;

    /* ---- 5) ดูคอลัมน์จริง แล้วจับคู่ ---- */
    console.log('');
    console.log('กำลังอ่านคอลัมน์ของ ' + view + ' ...');
    const { columns, rows } = await peek(cfg.sql, view);
    console.log('คอลัมน์ที่พบ: ' + columns.join(', '));
    if (rows[0]) console.log('ตัวอย่างแถวแรก: ' + JSON.stringify(rows[0]).slice(0, 300));

    const job = { name: '', enabled: true, target: target, view: view, top: 5000, columns: {} };
    const auto = buildHeadMap(job, columns);
    const spec = MAPS[target];
    const got = Object.values(auto);
    console.log('');
    console.log('จับคู่อัตโนมัติได้: ' + (Object.keys(auto).length
      ? Object.keys(auto).map(c => c + ' → ' + auto[c]).join(', ') : '(ไม่ได้เลย)'));

    /* คอลัมน์ที่จำเป็นแต่จับคู่ไม่ได้ → ให้เลือกเอง */
    for (const need of spec.need) {
      if (got.indexOf(need) > -1) continue;
      console.log('');
      console.log('** ยังไม่รู้ว่าคอลัมน์ไหนคือ "' + need + '" **');
      const ci = await askPick(rl, 'เลือกคอลัมน์ที่เป็น ' + need, columns);
      job.columns[need] = columns[ci];
    }
    /* จับคู่คอลัมน์ที่เหลือเพิ่มเอง — เลือกช่องของระบบ แล้วเลือกคอลัมน์ ทำซ้ำจนกว่าจะพอ */
    const DONE = '— พอแล้ว ไปต่อ —';
    for (;;) {
      const left = Object.keys(spec.map).filter(f => Object.values(buildHeadMap(job, columns)).indexOf(f) < 0);
      if (!left.length) break;
      const fi = await askPick(rl, 'จับคู่คอลัมน์เพิ่มไหม (เลือกช่องที่ต้องการ)',
        left.map(f => f + ' (' + spec.map[f][0] + ')').concat([DONE]), left.length + 1);
      if (fi === left.length) break;
      const used = Object.keys(buildHeadMap(job, columns));
      const pickCols = columns.filter(c => used.indexOf(c) < 0);
      if (!pickCols.length) { console.log('  ** ไม่เหลือคอลัมน์ให้จับคู่แล้ว **'); break; }
      const ci = await askPick(rl, 'คอลัมน์ไหนคือ "' + left[fi] + '"', pickCols.concat([DONE]), pickCols.length + 1);
      if (ci === pickCols.length) continue;
      job.columns[left[fi]] = pickCols[ci];
      console.log('  จับคู่แล้ว: ' + pickCols[ci] + ' → ' + left[fi]);
    }

    /* ---- 6) ชื่องาน + รอบเวลา + บัญชี Supabase ---- */
    job.name = await ask(rl, 'ตั้งชื่องานนี้', view + ' → ' + (target === 'documents' ? 'เอกสาร' : 'รถ'));
    cfg.everyMinutes = Number(await ask(rl, 'ดึงซ้ำทุกกี่นาที', cfg.everyMinutes || 30)) || 30;
    if (!cfg.supabase.serviceKey) {
      cfg.supabase.email = await ask(rl, 'อีเมลบัญชี KanBarcode ที่ใช้เขียนข้อมูล', cfg.supabase.email || '');
      cfg.supabase.password = await ask(rl, 'รหัสผ่านบัญชีนั้น', cfg.supabase.password || '');
    }

    const same = cfg.jobs.findIndex(j => j.name === job.name);
    if (same >= 0) cfg.jobs[same] = job; else cfg.jobs.push(job);
    saveConfig(cfg);

    console.log('');
    log('บันทึกลง sync-config.json แล้ว — งาน "' + job.name + '" ดึงจาก ' + view +
      ' ใน ' + cfg.sql.database + ' ทุก ' + cfg.everyMinutes + ' นาที');
    console.log('');
    console.log('ขั้นต่อไป:  node sync-sql.js --once     ← ลองดึงจริงหนึ่งรอบ');
    console.log('           sync-start.bat              ← รันค้างไว้');
  } finally {
    rl.close();
  }
}

/* ---------------- งานหนึ่งรอบ ---------------- */
async function runJob(cfg, job, state) {
  const spec = MAPS[job.target];
  if (!spec) { log('ข้ามงาน "' + job.name + '" — target ต้องเป็น documents หรือ vehicles'); return; }

  const { columns, rows } = await readSql(cfg, job);
  if (!rows.length) { log('[' + job.name + '] ไม่มีข้อมูลใน ' + (job.view || 'query')); return; }

  const head = buildHeadMap(job, columns);
  const fields = Object.values(head);
  const miss = spec.need.filter(f => fields.indexOf(f) < 0);
  if (miss.length) {
    log('[' + job.name + '] ไม่พบคอลัมน์ที่จำเป็น: ' + miss.join(', ') +
      ' — คอลัมน์ที่อ่านได้: ' + columns.join(', ') +
      ' (ระบุเองได้ที่ "columns" ใน sync-config.json)');
    return;
  }

  /* SQL → รูปแบบของระบบ */
  const recs = [];
  const seen = new Set();
  rows.forEach(r => {
    const o = {};
    for (const col in head) o[head[col]] = r[col];
    const rec = job.target === 'documents' ? toDocRow(o) : toVehRow(o);
    const key = rec[spec.pk];
    if (!key || seen.has(key)) return;      /* ไม่มีคีย์ หรือซ้ำในรอบเดียวกัน */
    seen.add(key);
    recs.push(rec);
  });
  if (!recs.length) { log('[' + job.name + '] อ่านมา ' + rows.length + ' แถว แต่ไม่มีแถวที่มีคีย์ใช้ได้'); return; }

  const existing = await sbSelectKeys(cfg, spec.table, spec.pk);
  const st = state[job.name] = state[job.name] || {};
  const fresh = [], update = [];
  recs.forEach(rec => {
    const key = rec[spec.pk];
    const sig = JSON.stringify(rec);
    if (existing.has(key)) {
      if (st[key] !== sig) update.push(rec);     /* ของเดิม: อัปเดตเฉพาะรายละเอียด */
    } else {
      fresh.push(rec);                           /* ของใหม่: เพิ่มเข้าไป */
    }
    st[key] = sig;
  });

  if (!fresh.length && !update.length) {
    log('[' + job.name + '] อ่าน ' + recs.length + ' แถว — ไม่มีอะไรเปลี่ยน');
    return;
  }
  /* แถวใหม่ของเอกสารเริ่มที่ "ยังไม่จัด" เสมอ ส่วนแถวเดิมไม่แตะ status/vehicle_id */
  if (fresh.length) {
    const payload = job.target === 'documents'
      ? fresh.map(r => Object.assign({}, r, { status: 'ยังไม่จัด', source: job.name || 'SQL Server' }))
      : fresh;
    await sbUpsert(cfg, spec.table, payload, spec.pk);
  }
  if (update.length) await sbUpsert(cfg, spec.table, update, spec.pk);

  log('[' + job.name + '] อ่าน ' + recs.length + ' แถว → เพิ่มใหม่ ' + fresh.length +
    ', อัปเดต ' + update.length + (job.target === 'documents' ? ' (ไม่แตะสถานะและรถของเดิม)' : ''));
}

async function runOnce(cfg) {
  const state = loadState();
  const who = await sbLogin(cfg);
  log('เชื่อมต่อ Supabase แล้ว (' + who + ')');
  for (const job of cfg.jobs) {
    try { await runJob(cfg, job, state); }
    catch (err) { log('[' + (job.name || job.target) + '] ผิดพลาด: ' + ((err && err.message) || err)); }
  }
  saveState(state);
}

(async function main() {
  if (LIST) { try { await runList(); } catch (e) { log('ผิดพลาด: ' + ((e && e.message) || e)); process.exitCode = 1; } return; }
  if (PICK) { try { await runPick(); } catch (e) { log('ผิดพลาด: ' + ((e && e.message) || e)); process.exitCode = 1; } return; }

  const cfg = loadConfig();
  log('===== เริ่มทำงาน — ' + cfg.jobs.length + ' งาน, ทุก ' + cfg.everyMinutes + ' นาที' + (ONCE ? ' (รอบเดียว)' : '') + ' =====');
  try { await runOnce(cfg); }
  catch (err) { log('ผิดพลาด: ' + ((err && err.message) || err)); }
  if (ONCE) { log('จบรอบเดียวตามที่สั่ง'); return; }

  setInterval(async () => {
    try { await runOnce(cfg); }
    catch (err) { log('ผิดพลาด: ' + ((err && err.message) || err)); }
  }, Math.max(1, cfg.everyMinutes) * 60000);
  log('รอรอบถัดไป... (ปิดด้วย Ctrl+C)');
})();
