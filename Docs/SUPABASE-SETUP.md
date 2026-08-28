# ตั้งค่า Supabase สำหรับระบบ Login ของ KanBarcode

ทำครั้งเดียวจบ ใช้เวลาประมาณ 10 นาที — ใช้แค่ **Project URL** กับ **anon public key**
ไม่ต้องใช้ service_role key และไม่ต้องมี backend เพิ่ม

---

## ทางลัดสำหรับโปรเจกต์นี้ — `mxjdzpfxndspwdlobxha` ↔ Vercel `kan-barcode`

ทำ 4 ข้อนี้ตามลำดับ แล้วล็อกอินได้เลย (ข้อ 1–7 ด้านล่างเป็นคำอธิบายแบบละเอียดของแต่ละขั้น)

**ก. สร้างตาราง** — [Supabase → SQL Editor](https://supabase.com/dashboard/project/mxjdzpfxndspwdlobxha/sql/new)
วางไฟล์ [`supabase/schema.sql`](../supabase/schema.sql) ทั้งไฟล์ → **Run** (ทำครั้งเดียวตลอด)

**ข. สร้าง user + password** — SQL Editor หน้าเดิม
วางไฟล์ [`supabase/create-admin.sql`](../supabase/create-admin.sql) ทั้งไฟล์
แก้ 3 บรรทัดในบล็อก `แก้ตรงนี้` (อีเมล / รหัสผ่าน / ชื่อ) → **Run**

ไฟล์นี้ทำให้ครบทั้งบัญชีใน `auth.users`, แถวใน `auth.identities` (ขาดตัวนี้จะขึ้น
*อีเมลหรือรหัสผ่านไม่ถูกต้อง* ทั้งที่รหัสผ่านถูก) และสิทธิ์ admin ใน `public.profiles`
ในคำสั่งเดียว — ไม่ต้องไปกดที่หน้า Users เลย และรันซ้ำได้เพื่อตั้งรหัสผ่านใหม่

ผลลัพธ์ต้องขึ้น ✅ ครบทั้ง 3 คอลัมน์ในตารางที่แสดงท้ายสคริปต์

**ค. ตั้งค่า Authentication** — [Auth → URL Configuration](https://supabase.com/dashboard/project/mxjdzpfxndspwdlobxha/auth/url-configuration)

| ช่อง | ค่า |
|---|---|
| Site URL | `https://kan-barcode.vercel.app` (ดูโดเมนจริงที่ Vercel → Project → Domains) |
| Redirect URLs | `https://kan-barcode.vercel.app/**` และ `http://localhost:3000/**` |

แล้วที่ [Auth → Sign In / Providers → Email](https://supabase.com/dashboard/project/mxjdzpfxndspwdlobxha/auth/providers)
→ **ปิด Confirm email** และ **เปิด Allow new users to sign up** (ดูเหตุผลที่ข้อ 3)

**ง. ผูกค่าเข้ากับ Vercel** — คัดลอก **anon public key** จาก
[Project Settings → API Keys](https://supabase.com/dashboard/project/mxjdzpfxndspwdlobxha/settings/api-keys)
(ป้าย `anon` `public` หรือ `sb_publishable_...` — **ห้ามใช้** `service_role` / `sb_secret_...`)

ไปที่ **Vercel → kan-barcode → Settings → Environment Variables** ใส่สองตัวนี้
ติ๊กครบทั้ง Production / Preview / Development

| Key | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://mxjdzpfxndspwdlobxha.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon public key ที่คัดลอกมา |

แล้ว **Deployments → ... → Redeploy** หนึ่งครั้ง (ตัวแปรผูกกับ deployment
ถ้าไม่ redeploy ค่าใหม่จะยังไม่มีผล)

**ตรวจว่าเชื่อมติดแล้ว** — เปิด `https://kan-barcode.vercel.app/api/config`
ต้องได้ `{"ok":true,"url":"https://mxjdzpfxndspwdlobxha.supabase.co","key":"..."}`
ถ้าได้ `ok:false` แปลว่าตัวแปรยังไม่ถึง deployment (ยังไม่ได้ redeploy หรือสะกดชื่อ key ผิด)

จากนั้นเปิดหน้าเว็บ ล็อกอินด้วยอีเมล/รหัสผ่านจากข้อ ข.

> ถ้าใช้ **Vercel Marketplace → Supabase integration** แทน มันจะฉีดตัวแปรชื่อ
> `SUPABASE_URL` / `SUPABASE_ANON_KEY` ให้เอง — [`api/config.js`](../api/config.js)
> อ่านชื่อนี้ได้อยู่แล้ว ไม่ต้องตั้งซ้ำ

---

## 1. สร้างโปรเจกต์ Supabase

1. เข้า <https://supabase.com> → **New project**
2. ตั้งชื่อโปรเจกต์ (เช่น `kanbarcode`) ตั้ง Database password เก็บไว้ให้ดี
3. เลือก Region ที่ใกล้ที่สุด → **Singapore (Southeast Asia)**
4. รอสร้างเสร็จประมาณ 2 นาที

---

## 2. สร้างตารางและ Row Level Security

1. เมนูซ้าย → **SQL Editor** → **New query**
2. เปิดไฟล์ [supabase/schema.sql](../supabase/schema.sql) คัดลอก **ทั้งไฟล์** มาวาง
3. กด **Run** — ต้องขึ้น `Success. No rows returned`

ไฟล์นี้จะสร้าง

| สิ่งที่สร้าง | หน้าที่ |
|---|---|
| ตาราง `public.profiles` | เก็บชื่อ ระดับสิทธิ์ (admin/user) เมนูที่เข้าถึงได้ และสถานะเปิด/ระงับ |
| Row Level Security | ผู้ใช้ทั่วไปเห็นเฉพาะแถวของตัวเองและแก้อะไรไม่ได้ / มีแต่ admin ที่แก้สิทธิ์ได้ |
| Trigger `on_auth_user_created` | มีบัญชีใหม่เมื่อไหร่ สร้างแถวสิทธิ์ให้อัตโนมัติ โดยบังคับเป็น `user` + `ปิดใช้งาน` เสมอ |

> **ทำไมบัญชีใหม่ถึงถูกปิดใช้งานไว้ก่อน**
> anon key เป็นคีย์สาธารณะ ใครก็ยิง `signUp` เข้ามาได้ — trigger จึงไม่ยอมให้ใครตั้ง
> ระดับสิทธิ์ตัวเองตอนสมัคร ต้องรอ admin กดเปิดใช้งานให้เท่านั้นถึงจะเข้าระบบได้

---

## 3. ตั้งค่า Authentication

เมนูซ้าย → **Authentication**

**Sign In / Providers → Email**

| ตัวเลือก | ค่าที่ควรตั้ง | เหตุผล |
|---|---|---|
| Enable Email provider | **เปิด** | ใช้ล็อกอินด้วยอีเมล + รหัสผ่าน |
| Confirm email | **ปิด** | admin เป็นคนสร้างบัญชีให้ ผู้ใช้จะได้เข้าระบบได้ทันทีไม่ต้องรออีเมลยืนยัน |
| Allow new users to sign up | **เปิด** | จำเป็น เพราะหน้า "เพิ่มผู้ใช้งาน" ใช้ `signUp` — ปลอดภัยอยู่แล้วเพราะบัญชีใหม่ถูกปิดใช้งานไว้ |
| Minimum password length | **8** | ให้ตรงกับที่หน้าเว็บตรวจ |

**URL Configuration**

- **Site URL** → ใส่ URL ของเว็บที่ deploy จริง เช่น `https://kanbarcode.vercel.app`
- **Redirect URLs** → เพิ่ม URL เดียวกัน (และ `http://localhost:3000` ถ้าทดสอบเครื่องตัวเอง)

ค่านี้ใช้ตอนกด "ลืมรหัสผ่าน" — ลิงก์ในอีเมลจะเด้งกลับมาที่ URL นี้

---

## 4. สร้างบัญชี admin คนแรก

**วิธีที่แนะนำ** — รัน [`supabase/create-admin.sql`](../supabase/create-admin.sql) ใน SQL Editor
จบในคำสั่งเดียว ทั้งบัญชี รหัสผ่าน identity และสิทธิ์ admin (ดูทางลัดข้อ ข. ด้านบน)

**หรือทำเองทีละขั้น**

1. **Authentication → Users → Add user → Create new user**
2. กรอกอีเมลกับรหัสผ่าน แล้ว **ติ๊ก Auto Confirm User**
3. กลับไปที่ **SQL Editor** รันคำสั่งนี้ (เปลี่ยนอีเมลเป็นของคุณ)

```sql
update public.profiles set
  role      = 'admin',
  active    = true,
  full_name = 'ผู้ดูแลระบบ',
  perms     = '{"dashboard":true,"scan":true,"calendar":true,"map":true,
                "docs":true,"vehicles":true,"reports":true,"users":true}'::jsonb
where lower(email) = lower('you@example.com');
```

ต้องขึ้น `Success. 1 row` — ถ้าขึ้น `0 rows` แปลว่าอีเมลไม่ตรง ให้เช็คใหม่

---

## 5. เชื่อมหน้าเว็บเข้ากับ Supabase

**Project Settings → API** จะเห็นค่าสองตัว

- **Project URL** — เช่น `https://abcdefghijkl.supabase.co`
- **anon / public key** — สตริงยาวขึ้นต้นด้วย `eyJ...`

> ในหน้าเดียวกันจะมี **service_role** อยู่ด้วย — **ห้ามใช้เด็ดขาด** เพราะข้าม RLS ได้ทั้งหมด
> (ถ้าเผลอใส่ ระบบจะตรวจจับและปฏิเสธพร้อมแจ้งเตือน)

เว็บจะไล่หาค่าจาก 3 ที่ตามลำดับนี้ เจอที่ไหนก่อนใช้ที่นั่น

### วิธี ก. Environment Variables บน Vercel (แนะนำ)

**Vercel → โปรเจกต์ → Settings → Environment Variables** เพิ่มสองตัว

| Key | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon public key |

เลือก Environment ให้ครบทั้ง **Production / Preview / Development** แล้ว **Redeploy หนึ่งครั้ง**

> **สำคัญ** — เว็บนี้เป็น static HTML ไฟล์เดียว **ไม่มี build step** ตัวแปร `NEXT_PUBLIC_*`
> จึงไม่ถูกฝังลงหน้าเว็บตอน build เหมือนโปรเจกต์ Next.js
> ระบบเลยอ่านค่าผ่าน serverless function [`api/config.js`](../api/config.js) ตอนเปิดเว็บแทน
> ผลลัพธ์เหมือนกันคือไม่ต้องเอาคีย์ไปฝังใน git แต่ **ต้อง Redeploy** ทุกครั้งที่แก้ตัวแปร
> เพราะ Vercel ผูก environment variables ไว้กับ deployment

ชื่อ `SUPABASE_URL` / `SUPABASE_ANON_KEY` หรือ `VITE_SUPABASE_*` ก็ใช้ได้เช่นกัน

### วิธี ข. ฝังมากับโค้ด

เปิด `index.html` หาสองบรรทัดนี้ (อยู่ใต้หัวข้อ `AUTH — Supabase`) แล้วใส่ค่าลงไป

```js
const SUPABASE_URL = 'https://abcdefghijkl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6...';
```

ข้อดีคือเปิดไฟล์ตรง ๆ ก็ใช้ได้ ไม่ต้องพึ่ง serverless function — แต่คีย์จะติดไปกับ git

### วิธี ค. กรอกที่หน้าเว็บ (ใช้เฉพาะเครื่องนั้น)

ถ้าไม่เจอค่าจากสองวิธีข้างบน หน้าแรกจะขึ้นช่องให้กรอก **Project URL** และ **anon public key**
→ กด **เชื่อมต่อ Supabase** ค่าจะเก็บใน localStorage ของเครื่องนั้น กรอกครั้งเดียวต่อเครื่อง
(แก้ไขภายหลังได้จากลิงก์ **ตั้งค่าการเชื่อมต่อ** มุมขวาล่างของกล่อง login)

เหมาะกับตอนทดสอบในเครื่องด้วย `npx serve` ซึ่งไม่มี `/api/config` ให้เรียก
ถ้ามีค่าจากวิธี ก. หรือ ข. อยู่แล้ว ลิงก์นี้จะถูกซ่อนไปเพราะกรอกไปก็ไม่มีผล

---

## 6. เพิ่มผู้ใช้งานคนอื่น

ล็อกอินด้วยบัญชี admin → เมนู **สิทธิ์ผู้ใช้งาน** → **+ เพิ่มผู้ใช้งาน**

- กรอกอีเมล ชื่อ-นามสกุล เลือกระดับสิทธิ์และเมนูที่เข้าถึงได้
- ระบบสุ่ม **รหัสผ่านชั่วคราว** มาให้ (แก้เองได้) — คัดลอกไปแจ้งผู้ใช้
- ผู้ใช้เข้าระบบแล้วเปลี่ยนรหัสผ่านเองได้ที่ปุ่ม **เปลี่ยนรหัสผ่าน** มุมขวาบน
- หรือ admin กด **ส่งลิงก์รหัสผ่าน** ให้ตั้งรหัสผ่านใหม่ทางอีเมลก็ได้

**ระงับผู้ใช้** — กด *แก้ไข* แล้วเอาติ๊ก "เปิดใช้งานบัญชีนี้" ออก → เข้าระบบไม่ได้ทันที

**ลบผู้ใช้** — ปุ่ม *ลบ* จะลบเฉพาะสิทธิ์ (แถวใน `profiles`) ซึ่งพอให้เข้าระบบไม่ได้แล้ว
ถ้าต้องการลบบัญชีถาวรให้ไปลบที่ **Authentication → Users** ด้วย
(anon key ไม่มีสิทธิ์ลบบัญชีใน Supabase Auth ตามการออกแบบ)

---

## แก้ปัญหาที่พบบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `อีเมลหรือรหัสผ่านไม่ถูกต้อง` ทั้งที่พิมพ์ถูก | บัญชียังไม่ได้ Confirm — ไปที่ Authentication → Users กด Confirm ให้ หรือปิด Confirm email ตามข้อ 3 |
| `บัญชีนี้ยังไม่ได้เปิดใช้งาน หรือถูกระงับ` | `active = false` ให้ admin เข้าไปติ๊กเปิดใช้งานที่หน้าสิทธิ์ผู้ใช้งาน |
| `บัญชีนี้ยังไม่มีข้อมูลสิทธิ์ในระบบ` | ถูกสร้างก่อนติดตั้ง trigger — รัน `insert into public.profiles (id, email) select id, email from auth.users on conflict do nothing;` แล้วค่อยตั้งสิทธิ์ |
| `ยังไม่ได้สร้างตาราง profiles` | ยังไม่ได้รัน `supabase/schema.sql` ให้ย้อนกลับไปข้อ 2 |
| `Supabase ปิดการสมัครบัญชีใหม่อยู่` ตอนกดเพิ่มผู้ใช้ | เปิด *Allow new users to sign up* ตามข้อ 3 |
| กดลิงก์ในอีเมลแล้วไม่ขึ้นหน้าตั้งรหัสผ่าน | ยังไม่ได้ตั้ง Site URL / Redirect URLs ตามข้อ 3 |
| ล็อกอินไม่ได้ตอนเปิดไฟล์ `index.html` ตรง ๆ (file://) | ปกติ — ให้ deploy ขึ้น Vercel หรือรัน `npx serve` แล้วเปิดผ่าน `http://localhost` |
| ตั้ง env ที่ Vercel แล้ว แต่เว็บยังขึ้นช่องให้กรอกค่า | ยังไม่ได้ **Redeploy** — ตัวแปรมีผลกับ deployment ใหม่เท่านั้น |
| เปิด `/api/config` แล้วขึ้น 404 | ไฟล์ `api/config.js` ยังไม่ได้ deploy หรือกำลังรัน static server ธรรมดา (ใช้วิธี ค. แทน) |
| ขึ้นว่า *คีย์ที่ตั้งไว้เป็น service_role* | ใส่คีย์ผิดตัว — กลับไปคัดลอกอันที่ป้ายเขียนว่า `anon` `public` |

---

## สรุปว่าอะไรอยู่ที่ไหน

| ข้อมูล | เก็บที่ |
|---|---|
| บัญชี อีเมล รหัสผ่าน (hash) | Supabase Auth — `auth.users` |
| ชื่อ ระดับสิทธิ์ เมนู สถานะ | Supabase — `public.profiles` |
| session ที่ล็อกอินค้างไว้ | localStorage ของเบราว์เซอร์ (คีย์ `kanbarcode.v2.auth`) |
| Project URL + anon key | Environment Variables บน Vercel (อ่านผ่าน `/api/config`) |
| เอกสาร รถ การจอง | localStorage ของเบราว์เซอร์ (ยังไม่ได้ย้ายขึ้น Supabase) |
