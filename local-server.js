/* ============================================================
   KanBarcode — เซิร์ฟเวอร์สำหรับรันในวง LAN
   ------------------------------------------------------------
   ใช้ตอน SQL Server อยู่ในวงเน็ตเวิร์กภายใน ซึ่ง Vercel มองไม่เห็น
   (Vercel อยู่บนอินเทอร์เน็ต ต่อเข้า 192.168.x.x ของบริษัทไม่ได้)

   วิธีใช้ — ทำบนเครื่องในวงเดียวกับ SQL Server
     npm install
     npm start                 (หรือ  node local-server.js)
   แล้วให้ทุกเครื่องในวงเปิด  http://<ไอพีเครื่องนี้>:3000

   เสิร์ฟให้ครบทั้ง
     /                     หน้าเว็บ index.html
     /api/sqlserver        ต่อ SQL Server (ไฟล์เดียวกับที่ใช้บน Vercel)
     /api/config           ค่า Supabase จาก Environment Variables

   ค่า Supabase อ่านจากตัวแปรแวดล้อม เหมือนบน Vercel เป๊ะ ๆ
   ตั้งก่อนสั่ง npm start (Windows PowerShell)
     $env:NEXT_PUBLIC_SUPABASE_URL      = "https://xxxx.supabase.co"
     $env:NEXT_PUBLIC_SUPABASE_ANON_KEY = "eyJhbGci..."
   ถ้าไม่ตั้ง หน้าเว็บจะให้กรอก Project URL / anon key เองที่หน้าล็อกอิน
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ROOT = __dirname;

const API = {
  '/api/sqlserver': require('./api/sqlserver'),
  '/api/config': require('./api/config')
};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.sql': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

/* ฟังก์ชันใน api/ เขียนตามแบบ Vercel (res.status().json()) — เติมให้ http ธรรมดา */
function shim(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const route = url.pathname.replace(/\/+$/, '') || '/';

  if (API[route]) {
    shim(res);
    try { await API[route](req, res); }
    catch (err) {
      if (!res.writableEnded) res.status(500).json({ ok: false, error: (err && err.message) || String(err) });
    }
    return;
  }

  /* ไฟล์ static — กันเรียกออกนอกโฟลเดอร์โปรเจกต์ */
  const rel = route === '/' ? 'index.html' : decodeURIComponent(route).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.statusCode = 403; res.end('403'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('ไม่พบไฟล์: ' + rel);
      return;
    }
    res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(buf);
  });
});

server.listen(PORT, () => {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name in nets) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  console.log('KanBarcode พร้อมใช้งานแล้ว');
  console.log('  เครื่องนี้      : http://localhost:' + PORT);
  ips.forEach(ip => console.log('  เครื่องอื่นในวง : http://' + ip + ':' + PORT));
  console.log('');
  console.log('หน้าเชื่อมต่อ SQL Server: เมนู "ข้อมูลเอกสาร" → แท็บ "เชื่อมต่อ SQL Server"');
  console.log('ช่อง API Endpoint ให้ใส่ /api/sqlserver ตามเดิม');
});
