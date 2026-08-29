/* ============================================================
   KanBarcode — Serverless API สำหรับเชื่อมต่อ SQL Server
   ใช้บน Vercel (Node.js runtime)  →  POST /api/sqlserver
   ------------------------------------------------------------
   ใช้เหมือน Excel → Data → From Database → From SQL Server Database
   ------------------------------------------------------------
   body: { action, server, port, database, user, password, view }

     action:'test'       ต่อได้ไหม            → { ok, version, database }
     action:'databases'  รายชื่อฐานข้อมูล      → { ok, databases:['ERP', ...] }
     action:'objects'    ตาราง/วิวในฐานข้อมูล  → { ok, objects:[{schema,name,type}] }
     action:'preview'    ตัวอย่าง 50 แถวแรก    → { ok, columns, rows }
     action:'pull'       ดึงข้อมูลจริง         → { ok, columns, rows, truncated }

   ผิดพลาด → { ok:false, error:'...' }
   ============================================================ */
/* ------------------------------------------------------------
   หาไอพีของชื่อเครื่องก่อนต่อ
   Windows: ชื่อเครื่องในวง LAN อย่าง "bcs-server" มักไม่มีใน DNS
   แต่หาเจอผ่าน NetBIOS/LLMNR — ซึ่ง getaddrinfo ของ Node คืน
   EBUSY ออกมาแทนที่จะหาเจอ (Failed to connect ... getaddrinfo EBUSY)
   จึงถอยไปถาม ping ที่ใช้กลไกเดียวกับที่ Windows Explorer ใช้แทน
   ------------------------------------------------------------ */
const dns = require('dns');
const { execFile } = require('child_process');

function isIp(h) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.indexOf(':') > -1; }

/* เครื่องปลายทางอยู่ในวงเน็ตเวิร์กภายในหรือเปล่า (ไอพีส่วนตัว หรือชื่อเครื่องสั้น ๆ ที่ไม่มีจุด) */
function isLanTarget(h) {
  const host = String(h || '').trim().split(/[\,]/)[0];
  if (!host) return false;
  if (/^(10\.|127\.|192\.168\.|169\.254\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/\.local$/i.test(host)) return true;
  return host.indexOf('.') < 0;      /* เช่น bcs-server */
}

function pingLookup(host) {
  return new Promise(resolve => {
    execFile('ping', ['-n', '1', '-4', '-w', '1500', host], { timeout: 6000, windowsHide: true },
      (err, stdout) => {
        const m = String(stdout || '').match(/\[(\d{1,3}(?:\.\d{1,3}){3})\]/) ||
                  String(stdout || '').match(/(\d{1,3}(?:\.\d{1,3}){3})/);
        resolve(m ? m[1] : null);
      });
  });
}

const HOST_CACHE = new Map();   /* จำผลไว้ ไม่ต้องรอ DNS ใหม่ทุกครั้ง */

async function resolveHost(host) {
  host = String(host || '').trim();
  if (!host || isIp(host)) return host;
  if (HOST_CACHE.has(host)) return HOST_CACHE.get(host);
  const ip = await lookupHost(host);
  HOST_CACHE.set(host, ip);
  return ip;
}
async function lookupHost(host) {
  try {
    const r = await dns.promises.lookup(host, { family: 4 });
    if (r && r.address) return r.address;
  } catch (e) { /* หาไม่เจอทาง DNS — ลองทางอื่นต่อ */ }
  if (process.platform === 'win32') {
    const ip = await pingLookup(host);
    if (ip) return ip;
  }
  return host;   /* ปล่อยให้ไดรเวอร์ลองเอง จะได้เห็น error จริง */
}

/* แปล error ตอนหาเครื่องไม่เจอ ให้บอกทางแก้ไปเลย */
function hostError(err, host) {
  const m = String((err && err.message) || err);
  if (/EBUSY|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) {
    return 'หาเครื่อง "' + host + '" ไม่เจอในเครือข่าย (' + m + ')' +
      ' — ลองใส่เป็นเลขไอพีตรง ๆ แทนชื่อเครื่อง เช็คไอพีได้ด้วยคำสั่ง  ping ' + host;
  }
  return m;
}

const sql = require('mssql');

const MAX_ROWS = 5000;
const PREVIEW_ROWS = 50;

/* อนุญาตเฉพาะชื่อ view/table ที่เป็น identifier ปกติ (กัน SQL injection) */
function safeView(v) {
  const s = String(v || '').trim().replace(/[\[\]]/g, '');
  if (!s) return null;
  const parts = s.split('.');
  if (parts.length > 3) return null;
  for (const p of parts) {
    if (!/^[A-Za-z_\u0E00-\u0E7F][A-Za-z0-9_\u0E00-\u0E7F$#@ ]*$/.test(p)) return null;
  }
  return parts.map(p => '[' + p + ']').join('.');
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) reject(new Error('payload ใหญ่เกินไป')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('body ไม่ใช่ JSON')); } });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  /* เผื่อหน้าเว็บกับ API อยู่คนละ origin เช่นเปิดเว็บจาก Vercel แต่ API รันในวง LAN
     (ต้องส่ง Server/Database/user/password มาด้วยอยู่แล้ว จึงไม่ได้เปิดอะไรให้ฟรี) */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'รองรับเฉพาะ POST' });
    return;
  }

  let body;
  try { body = await readBody(req); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); return; }

  const ACTIONS = ['test', 'databases', 'objects', 'preview', 'pull'];
  const action = ACTIONS.indexOf(body.action) > -1 ? body.action : 'test';
  const server = String(body.server || '').trim();
  /* ตอนขอรายชื่อฐานข้อมูล ยังไม่รู้ว่าจะเลือกอันไหน → ต่อเข้า master ไปก่อน */
  const database = String(body.database || '').trim() || (action === 'databases' ? 'master' : '');
  const user = String(body.user || '').trim();
  const password = String(body.password || '');
  const port = parseInt(body.port, 10) || 1433;

  if (!server || !database) {
    res.status(400).json({ ok: false, error: 'ต้องระบุ Server และ Database' });
    return;
  }

  /* server อาจใส่มาเป็น "host\INSTANCE" หรือ "host,1433" */
  let host = server, instanceName;
  const BS = String.fromCharCode(92); /* backslash */
  if (host.includes(BS)) { const p = host.split(BS); host = p[0]; instanceName = p[1]; }
  if (host.includes(',')) { const p = host.split(','); host = p[0]; }

  /* API ตัวนี้รันอยู่บน Vercel (นอกวงบริษัท) จะต่อเข้าเครื่องในวง LAN ไม่ได้แน่ ๆ
     บอกให้รู้ตั้งแต่แรก ดีกว่าปล่อยให้รอหมดเวลา 15 วินาทีแล้วงงว่าทำไมต่อไม่ติด */
  if ((process.env.VERCEL || process.env.VERCEL_ENV) && isLanTarget(host)) {
    res.status(200).json({
      ok: false,
      error: 'เครื่อง "' + host + '" อยู่ในวงเน็ตเวิร์กภายใน แต่หน้าเว็บนี้เรียก API ที่รันอยู่บน Vercel ' +
        'ซึ่งอยู่นอกวงบริษัท จึงต่อเข้าไปไม่ได้ — ให้เปิดเว็บจากลิงก์ในวง LAN แทน ' +
        '(รัน start-lan.bat บนเครื่องในออฟฟิศ แล้วเปิด http://<ไอพีเครื่องนั้น>:3000) ' +
        'หรือใช้ตัวดึงข้อมูลอัตโนมัติ sync-sql.js'
    });
    return;
  }

  /* ชื่อเครื่องในวง LAN → แปลงเป็นไอพีก่อน กัน getaddrinfo EBUSY บน Windows */
  const original = host;
  host = await resolveHost(host);

  const config = {
    server: host,
    port,
    database,
    user,
    password,
    options: {
      encrypt: true,              /* Azure / SQL ใหม่ต้องเปิด */
      trustServerCertificate: true, /* SQL Server ในองค์กรมักใช้ self-signed cert */
      enableArithAbort: true,
      ...(instanceName ? { instanceName } : {})
    },
    connectionTimeout: 15000,
    requestTimeout: 60000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 10000 }
  };

  let pool;
  try {
    pool = await new sql.ConnectionPool(config).connect();

    if (action === 'test') {
      const r = await pool.request().query('SELECT @@VERSION AS version, DB_NAME() AS db');
      res.status(200).json({
        ok: true,
        version: r.recordset[0] && r.recordset[0].version,
        database: r.recordset[0] && r.recordset[0].db
      });
      return;
    }

    /* รายชื่อฐานข้อมูลที่บัญชีนี้เข้าถึงได้ — ฐานข้อมูลระบบไปอยู่ท้ายรายการ */
    if (action === 'databases') {
      const r = await pool.request().query(
        'SELECT name, CASE WHEN database_id <= 4 THEN 1 ELSE 0 END AS is_system ' +
        'FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ' +
        'ORDER BY is_system, name');
      res.status(200).json({
        ok: true,
        databases: r.recordset.map(x => x.name),
        system: r.recordset.filter(x => x.is_system).map(x => x.name)
      });
      return;
    }

    /* ตารางและวิวในฐานข้อมูลที่เลือก (ไม่เอาของที่มากับ SQL Server เอง) */
    if (action === 'objects') {
      const r = await pool.request().query(
        "SELECT s.name AS [schema], o.name AS [name], " +
        "CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'TABLE' END AS [type] " +
        'FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id ' +
        "WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0 " +
        'ORDER BY [type], s.name, o.name');
      res.status(200).json({ ok: true, database: database, objects: r.recordset });
      return;
    }

    const view = safeView(body.view);
    if (!view) {
      res.status(400).json({ ok: false, error: 'ชื่อ View / Table ไม่ถูกต้อง (ใช้ได้เฉพาะ schema.name)' });
      return;
    }

    const top = action === 'preview' ? PREVIEW_ROWS : MAX_ROWS;
    const r = await pool.request().query('SELECT TOP ' + top + ' * FROM ' + view);
    const columns = r.recordset && r.recordset.columns
      ? Object.keys(r.recordset.columns)
      : (r.recordset[0] ? Object.keys(r.recordset[0]) : []);
    const rows = r.recordset.map(row => {
      const o = {};
      for (const k in row) {
        const v = row[k];
        o[k] = v instanceof Date ? v.toISOString().slice(0, 10)
             : (Buffer.isBuffer(v) ? v.toString('hex') : v);
      }
      return o;
    });
    res.status(200).json({ ok: true, columns, rows, truncated: action !== 'preview' && rows.length >= MAX_ROWS });
  } catch (err) {
    res.status(200).json({ ok: false, error: hostError(err, original) });
  } finally {
    if (pool) { try { await pool.close(); } catch (e) { /* ปิดไม่ได้ก็ปล่อย */ } }
  }
};
