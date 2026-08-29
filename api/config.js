/* ============================================================
   KanBarcode — ส่งค่า Supabase (ฝั่ง public) ให้หน้าเว็บ
   GET /api/config  →  { ok:true, url, key }
   ------------------------------------------------------------
   เว็บนี้เป็น static HTML ไฟล์เดียว ไม่มี build step ตัวแปรแบบ
   NEXT_PUBLIC_* จึงไม่ถูกฝังลงหน้าเว็บตอน build เหมือน Next.js
   → หน้าเว็บเรียก endpoint นี้ตอนเปิดเว็บ เพื่ออ่านค่าจาก
     Environment Variables ของ Vercel ตอน runtime แทน

   ตั้งค่าที่ Vercel → Settings → Environment Variables
     NEXT_PUBLIC_SUPABASE_URL       = https://xxxx.supabase.co
     NEXT_PUBLIC_SUPABASE_ANON_KEY  = eyJhbGciOi...
   แล้ว Redeploy หนึ่งครั้ง (ตัวแปรใหม่จะมีผลกับ deployment ใหม่เท่านั้น)

   ค่าที่ส่งออกจาก endpoint นี้เป็นค่าสาธารณะโดยเจตนา — anon key
   ออกแบบมาให้เปิดเผยในหน้าเว็บได้ ความปลอดภัยอยู่ที่ Row Level
   Security ในฐานข้อมูล (ดู supabase/schema.sql)
   ============================================================ */

/* กันพลาด: ตรวจว่าคีย์ที่ใส่มาไม่ใช่ service_role / secret key
   ซึ่งข้าม RLS ได้ทั้งหมด และห้ามหลุดออกมาหน้าเว็บเด็ดขาด */
function isSecretKey(key) {
  if (/^sb_secret_/i.test(key)) return true;
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const payload = JSON.parse(json);
      if (payload && payload.role && payload.role !== 'anon') return true;
    } catch (e) { /* ไม่ใช่ JWT ที่อ่านได้ ก็ปล่อยผ่าน */ }
  }
  return false;
}

module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ ok: false, error: 'รองรับเฉพาะ GET' });
    return;
  }

  const env = process.env;
  const url = String(env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL || env.VITE_SUPABASE_URL || '')
    .trim().replace(/\/+$/, '');
  const key = String(env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || '')
    .trim();

  /* ยังไม่ได้ตั้งค่า → ไม่ถือเป็น error ให้หน้าเว็บไปถามผู้ใช้เอง */
  if (!url || !key) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: false,
      error: 'ยังไม่ได้ตั้ง NEXT_PUBLIC_SUPABASE_URL และ NEXT_PUBLIC_SUPABASE_ANON_KEY — บน Vercel ตั้งที่ Settings → Environment Variables แล้ว Redeploy หนึ่งครั้ง / ถ้ารันเองในเครื่องให้ตั้งตัวแปรก่อนสั่ง npm start'
    });
    return;
  }

  if (isSecretKey(key)) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ok: false,
      error: 'คีย์ที่ตั้งไว้เป็น service_role / secret key ซึ่งข้าม Row Level Security ได้ทั้งหมด — ให้เปลี่ยนเป็น anon public key จาก Project Settings → API'
    });
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
  res.status(200).json({ ok: true, url: url, key: key });
};
