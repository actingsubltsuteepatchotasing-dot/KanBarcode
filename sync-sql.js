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
     1) คัดลอก sync-config.example.json เป็น sync-config.json แล้วใส่ค่าจริง
     2) npm install         (ครั้งแรกครั้งเดียว)
     3) node sync-sql.js --once     ← ลองยิงรอบเดียวดูก่อน
        node sync-sql.js            ← รันค้างไว้ ดึงซ้ำตามรอบที่ตั้ง
        หรือดับเบิลคลิก sync-start.bat
   ============================================================ */
const fs = require('fs');
const path = require('path');
const sql = require('mssql');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'sync-config.json');
const STATE_FILE = path.join(ROOT, '.sync-state.json');
const LOG_FILE = path.join(ROOT, 'sync-sql.log');
const ONCE = process.argv.includes('--once');
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
function loadConfig() {
  loadEnvLocal();
  if (!fs.existsSync(CONFIG_FILE)) {
    log('ไม่พบไฟล์ sync-config.json — คัดลอก sync-config.example.json เป็น sync-config.json แล้วใส่ค่าจริงก่อน');
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
