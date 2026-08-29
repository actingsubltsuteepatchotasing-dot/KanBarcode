-- ============================================================
--  KanBarcode — ตารางข้อมูลของหน้าจออื่น ๆ
--  (เอกสาร / รถและคนขับ / การจองรถ / ค่าตั้งค่าส่วนกลาง)
--
--  รันไฟล์นี้ทั้งไฟล์ใน Supabase → SQL Editor → New query → Run
--  ต้องรัน supabase/schema.sql (ตาราง profiles) ให้ผ่านก่อน
--
--  หน้าเว็บ (index.html) ใช้ตารางพวกนี้จริงแล้ว — vehicles, documents,
--  document_logs, bookings  ส่วน localStorage เหลือไว้เป็นสำเนาสำรองในเครื่อง
--  ถ้าอัปเดตเว็บแล้วบันทึกขึ้นคลาวด์ไม่ได้ ให้รันไฟล์นี้ซ้ำอีกรอบ (รันซ้ำได้ไม่เสียข้อมูล)
-- ============================================================


-- ------------------------------------------------------------
--  0) ฟังก์ชันช่วยตรวจสิทธิ์  (ใช้ร่วมกันทุกตารางด้านล่าง)
--     อ่านจาก public.profiles ที่สร้างไว้ใน schema.sql
-- ------------------------------------------------------------

-- ผู้ใช้คนนี้ถูกเปิดใช้งานหรือยัง — ยังไม่เปิด = มองไม่เห็นข้อมูลอะไรเลย
create or replace function public.is_active_user()
returns boolean
language sql stable security definer set search_path = public
as $fn$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$fn$;

-- มีสิทธิ์เข้าเมนูนี้ไหม  (admin ได้ทุกเมนูเสมอ)
-- ชื่อเมนูตรงกับ MENUS ใน index.html:
--   dashboard scan calendar map docs vehicles reports users
create or replace function public.has_perm(menu text)
returns boolean
language sql stable security definer set search_path = public
as $fn$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and active
      and (role = 'admin' or coalesce((perms ->> menu)::boolean, false))
  );
$fn$;

revoke all on function public.is_active_user()    from public;
revoke all on function public.has_perm(text)      from public;
grant execute on function public.is_active_user() to authenticated;
grant execute on function public.has_perm(text)   to authenticated;

-- ประทับเวลาแก้ไขล่าสุด (schema.sql สร้างไว้แล้ว ใส่ซ้ำเผื่อรันไฟล์นี้เดี่ยว ๆ)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $fn$
begin new.updated_at = now(); return new; end;
$fn$;


-- ------------------------------------------------------------
--  1) รถและคนขับ            ← เมนู "รถและคนขับ" (vehicles)
--     ตรงกับ DB.vehicles ใน index.html
-- ------------------------------------------------------------
create table if not exists public.vehicles (
  id         text primary key,              -- 'KB-01'  รหัสรถ ผู้ใช้ตั้งเอง
  brand      text,                          -- brand
  model      text,                          -- model
  plate      text,                          -- plate     ทะเบียน
  driver     text,                          -- driver    ชื่อคนขับ
  phone      text,                          -- phone
  type       text,                          -- type      ประเภทรถ
  capacity   text,                          -- capacity  น้ำหนักบรรทุก
  note       text,                          -- note
  active     boolean     not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vehicles_active_idx on public.vehicles (active);

drop trigger if exists vehicles_touch on public.vehicles;
create trigger vehicles_touch before update on public.vehicles
  for each row execute function public.touch_updated_at();


-- ------------------------------------------------------------
--  2) เอกสารจัดส่ง          ← เมนู "ข้อมูลเอกสาร" / "ยิงบาร์โค้ด"
--     ตรงกับ DB.docs ใน index.html
--     docNo คือค่าที่ยิงจากเครื่องบาร์โค้ด จึงใช้เป็น primary key เลย
-- ------------------------------------------------------------
create table if not exists public.documents (
  doc_no     text primary key,              -- docNo     'KB-20260827-001'
  row_no     integer,                       -- row       ลำดับตอนนำเข้า
  doc_date   date,                          -- docDate
  cust_code  text,                          -- custCode
  cust_name  text,                          -- custName
  address    text,                          -- address   ที่อยู่เต็ม
  tambon     text,                          -- tambon    แยกจาก address
  amphoe     text,                          -- amphoe
  province   text,                          -- province  ใช้ปักหมุดแผนที่
  status     text        not null default 'ยังไม่จัด'
             check (status in ('ยังไม่จัด','จัดเสร็จแล้ว','ส่งแล้ว','ถึงมือลูกค้าแล้ว')),
  vehicle_id text references public.vehicles(id) on delete set null,
  source     text,                          -- source    'ตัวอย่าง' / 'SQL Server' / 'นำเข้าเอง'
  updated_by text,                          -- updatedBy อีเมลคนที่แก้ล่าสุด
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_status_idx   on public.documents (status);
create index if not exists documents_date_idx     on public.documents (doc_date desc);
create index if not exists documents_vehicle_idx  on public.documents (vehicle_id);
create index if not exists documents_province_idx on public.documents (province);
create index if not exists documents_cust_idx     on public.documents (cust_code);

drop trigger if exists documents_touch on public.documents;
create trigger documents_touch before update on public.documents
  for each row execute function public.touch_updated_at();


-- ------------------------------------------------------------
--  3) ประวัติการเปลี่ยนสถานะ  ← เดิมคือ array doc.log ใน localStorage
--     แยกเป็นตารางต่างหาก จะได้ทำรายงานย้อนหลังได้
-- ------------------------------------------------------------
create table if not exists public.document_logs (
  id         bigint generated always as identity primary key,
  doc_no     text        not null references public.documents(doc_no) on delete cascade,
  status     text        not null,          -- log[].status
  changed_by text,                          -- log[].by
  vehicle_id text,                          -- log[].vehicleId
                                            -- เก็บเป็นข้อความ ไม่ผูก FK เพราะเป็นบันทึก
                                            -- ประวัติ ต้องคงค่าไว้แม้รถคันนั้นถูกลบไปแล้ว
  changed_at timestamptz not null default now()   -- log[].t
);

create index if not exists document_logs_doc_idx  on public.document_logs (doc_no, changed_at desc);
create index if not exists document_logs_time_idx on public.document_logs (changed_at desc);

-- กันประวัติบรรทัดเดิมถูกส่งซ้ำจากหลายเครื่อง
-- หน้าเว็บส่งประวัติแบบ upsert ... on conflict do nothing โดยอ้าง index นี้เป็นเป้า
-- ⚠ ไม่มี index นี้ = เว็บจะเซฟประวัติสถานะขึ้นคลาวด์ไม่ได้
update public.document_logs set changed_by = '' where changed_by is null;
alter table public.document_logs alter column changed_by set default '';
alter table public.document_logs alter column changed_by set not null;

create unique index if not exists document_logs_uniq
  on public.document_logs (doc_no, changed_at, status, changed_by);


-- ------------------------------------------------------------
--  4) การจองรถ              ← เมนู "ปฏิทินรถ" (calendar)
--     ตรงกับ DB.bookings ใน index.html
-- ------------------------------------------------------------
create table if not exists public.bookings (
  id         text primary key,              -- id        'BK-xxxxx'
  vehicle_id text        not null references public.vehicles(id) on delete cascade,
  trip_date  date        not null,          -- date
  province   text,                          -- province
  depart     time,                          -- depart    เวลาออก '07:30'
  back_time  time,                          -- back      เวลากลับ '16:00'
  status     text        not null default 'จองแล้ว'
             check (status in ('ว่าง','จองแล้ว','เดินทางอยู่')),
  note       text,                          -- note
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bookings_date_idx    on public.bookings (trip_date);
create index if not exists bookings_vehicle_idx on public.bookings (vehicle_id, trip_date);

drop trigger if exists bookings_touch on public.bookings;
create trigger bookings_touch before update on public.bookings
  for each row execute function public.touch_updated_at();


-- ------------------------------------------------------------
--  5) ค่าตั้งค่าส่วนกลาง      ← เดิมคือ DB.mapKey และ DB.sql
--     ⚠ ห้ามเก็บรหัสผ่าน SQL Server ในนี้ — ตารางนี้ผู้ใช้ที่ล็อกอินอ่านได้
--       รหัสผ่านให้ผู้ใช้กรอกเองที่หน้าเว็บเหมือนเดิม
-- ------------------------------------------------------------
create table if not exists public.app_settings (
  key        text primary key,              -- 'map_key' / 'sqlserver'
  value      jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists app_settings_touch on public.app_settings;
create trigger app_settings_touch before update on public.app_settings
  for each row execute function public.touch_updated_at();


-- ============================================================
--  6) Row Level Security
--     หลักการเดียวกับ profiles — anon แตะอะไรไม่ได้เลย
--     ต้องล็อกอินแล้วถูกเปิดใช้งาน (active) ถึงจะอ่านได้
--     ส่วนการ "แก้ไข" ผูกกับสิทธิ์เมนูใน profiles.perms
-- ============================================================
alter table public.vehicles      enable row level security;
alter table public.documents     enable row level security;
alter table public.document_logs enable row level security;
alter table public.bookings      enable row level security;
alter table public.app_settings  enable row level security;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.vehicles, public.documents, public.document_logs,
  public.bookings, public.app_settings
  to authenticated;

-- ---------- รถและคนขับ ----------
-- อ่านได้ทุกคนที่เปิดใช้งาน (หน้าปฏิทิน/แผนที่/ยิงบาร์โค้ด ต้องใช้รายชื่อรถ)
drop policy if exists "vehicles read"  on public.vehicles;
drop policy if exists "vehicles write" on public.vehicles;

create policy "vehicles read" on public.vehicles
  for select to authenticated using (public.is_active_user());

create policy "vehicles write" on public.vehicles
  for all to authenticated
  using (public.has_perm('vehicles')) with check (public.has_perm('vehicles'));

-- ---------- เอกสาร ----------
-- แก้ไขได้ทั้งคนที่มีสิทธิ์เมนู "ข้อมูลเอกสาร" และเมนู "ยิงบาร์โค้ด"
-- (คนยิงบาร์โค้ดต้องอัปเดตสถานะได้) แต่ "ลบ" ให้เฉพาะเมนูเอกสาร
drop policy if exists "documents read"   on public.documents;
drop policy if exists "documents insert" on public.documents;
drop policy if exists "documents update" on public.documents;
drop policy if exists "documents delete" on public.documents;

create policy "documents read" on public.documents
  for select to authenticated using (public.is_active_user());

create policy "documents insert" on public.documents
  for insert to authenticated
  with check (public.has_perm('docs') or public.has_perm('scan'));

create policy "documents update" on public.documents
  for update to authenticated
  using      (public.has_perm('docs') or public.has_perm('scan'))
  with check (public.has_perm('docs') or public.has_perm('scan'));

create policy "documents delete" on public.documents
  for delete to authenticated using (public.has_perm('docs'));

-- ---------- ประวัติสถานะ ----------
-- เพิ่มได้ แก้ไม่ได้ ลบได้เฉพาะ admin — ประวัติต้องแก้ย้อนหลังไม่ได้
drop policy if exists "logs read"   on public.document_logs;
drop policy if exists "logs insert" on public.document_logs;
drop policy if exists "logs delete" on public.document_logs;

create policy "logs read" on public.document_logs
  for select to authenticated using (public.is_active_user());

create policy "logs insert" on public.document_logs
  for insert to authenticated
  with check (public.has_perm('docs') or public.has_perm('scan'));

create policy "logs delete" on public.document_logs
  for delete to authenticated using (public.is_admin());

-- ---------- การจองรถ ----------
drop policy if exists "bookings read"  on public.bookings;
drop policy if exists "bookings write" on public.bookings;

create policy "bookings read" on public.bookings
  for select to authenticated using (public.is_active_user());

create policy "bookings write" on public.bookings
  for all to authenticated
  using (public.has_perm('calendar')) with check (public.has_perm('calendar'));

-- ---------- ค่าตั้งค่าส่วนกลาง ----------
drop policy if exists "settings read"  on public.app_settings;
drop policy if exists "settings write" on public.app_settings;

create policy "settings read" on public.app_settings
  for select to authenticated using (public.is_active_user());

create policy "settings write" on public.app_settings
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());


-- ============================================================
--  7) ตรวจผลลัพธ์ — ควรได้ ✅ ครบทุกแถว
-- ============================================================
select
  t.tbl as "ตาราง",
  case when to_regclass('public.' || t.tbl) is null
       then '❌ ยังไม่มี' else '✅ สร้างแล้ว' end as "สถานะ",
  coalesce((select case when relrowsecurity then '✅ เปิด' else '❌ ปิด' end
            from pg_class where oid = to_regclass('public.' || t.tbl)), '-') as "RLS",
  coalesce((select count(*)::text from pg_policies
            where schemaname = 'public' and tablename = t.tbl), '0') as "policy"
from (values ('vehicles'),('documents'),('document_logs'),('bookings'),('app_settings')) as t(tbl);


-- ============================================================
--  8) ข้อมูลตัวอย่าง (ไม่บังคับ)
--     ลบเครื่องหมาย -- ข้างหน้าออก ถ้าอยากได้รถ 3 คันไว้ทดสอบ
-- ============================================================
-- insert into public.vehicles (id,brand,model,plate,driver,phone,type,capacity,note) values
--   ('KB-01','Isuzu','NPR 150','1ฒก 4521','สมชาย ใจดี','081-234-5678','รถบรรทุก 6 ล้อ','5 ตัน','มีลิฟท์ท้าย'),
--   ('KB-02','Hino','XZU 720','2ขค 8890','ประเสริฐ มั่นคง','082-345-6789','รถบรรทุก 6 ล้อ','8 ตัน','ตู้ทึบ'),
--   ('KB-03','Toyota','Hilux Revo','3กง 1200','วิชัย ตั้งใจ','083-456-7890','รถกระบะ','1 ตัน','ส่งของด่วนในเขต กทม.')
-- on conflict (id) do nothing;
