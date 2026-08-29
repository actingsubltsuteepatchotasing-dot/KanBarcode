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
    res.status(200).json({ ok: false, error: (err && err.message) || String(err) });
  } finally {
    if (pool) { try { await pool.close(); } catch (e) { /* ปิดไม่ได้ก็ปล่อย */ } }
  }
};
