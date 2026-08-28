-- ============================================================
--  KanBarcode — โครงสร้างฐานข้อมูลสำหรับระบบ login
--  รันไฟล์นี้ทั้งไฟล์ใน Supabase → SQL Editor → New query → Run
--
--  หน้าเว็บใช้แค่ Project URL + anon public key เท่านั้น
--  ความปลอดภัยทั้งหมดอยู่ที่ Row Level Security ด้านล่างนี้
-- ============================================================

-- ------------------------------------------------------------
-- 1) ตารางสิทธิ์ผู้ใช้  (ผูก 1:1 กับบัญชีใน auth.users)
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  role       text        not null default 'user' check (role in ('admin','user')),
  active     boolean     not null default false,
  perms      jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_email_key on public.profiles (lower(email));

alter table public.profiles enable row level security;

-- สิทธิ์ระดับตาราง — ปกติ Supabase ให้มาอัตโนมัติอยู่แล้ว
-- แต่ใส่ซ้ำไว้กันเหนียว ถ้าขาดจะขึ้น permission denied for table profiles
-- แม้ RLS policy จะผ่านก็ตาม
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.profiles to authenticated;

-- ------------------------------------------------------------
-- 2) ฟังก์ชันเช็ค admin
--    security definer → อ่านตารางได้โดยไม่วน RLS ซ้ำตัวเอง
-- ------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and active
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ------------------------------------------------------------
-- 3) Row Level Security
--    • ผู้ใช้ทั่วไป : อ่านได้เฉพาะแถวของตัวเอง แก้ไขอะไรไม่ได้เลย
--                    (กันการเลื่อนขั้นตัวเองเป็น admin)
--    • admin       : อ่าน/แก้ไข/ลบได้ทุกแถว ยกเว้นลบตัวเอง
-- ------------------------------------------------------------
drop policy if exists "profiles read own"    on public.profiles;
drop policy if exists "profiles read admin"  on public.profiles;
drop policy if exists "profiles write admin" on public.profiles;
drop policy if exists "profiles insert admin" on public.profiles;
drop policy if exists "profiles delete admin" on public.profiles;

create policy "profiles read own" on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy "profiles read admin" on public.profiles
  for select to authenticated
  using (public.is_admin());

create policy "profiles write admin" on public.profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "profiles insert admin" on public.profiles
  for insert to authenticated
  with check (public.is_admin());

create policy "profiles delete admin" on public.profiles
  for delete to authenticated
  using (public.is_admin() and id <> auth.uid());

-- ------------------------------------------------------------
-- 4) สร้างแถว profile อัตโนมัติเมื่อมีบัญชีใหม่
--    role/active ถูก "ฝังตาย" เป็น user / false เสมอ
--    → ต่อให้ใครยิง signUp ตรง ๆ ด้วย anon key ก็เข้าระบบไม่ได้
--      จนกว่า admin จะกดเปิดใช้งานให้
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role, active, perms)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'full_name',''), split_part(new.email,'@',1)),
    'user', false, '{}'::jsonb
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- 5) อีเมลเปลี่ยนที่ Supabase → sync ลง profiles ให้ด้วย
-- ------------------------------------------------------------
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email, updated_at = now() where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- ------------------------------------------------------------
-- 6) ประทับเวลาแก้ไขล่าสุด
-- ------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();


-- ============================================================
--  ขั้นตอนสุดท้าย: ตั้งบัญชี admin คนแรก
--  ------------------------------------------------------------
--  1. สร้างบัญชีก่อนที่ Authentication → Users → Add user
--     (ติ๊ก Auto Confirm User ด้วย)
--  2. เปลี่ยนอีเมลข้างล่างเป็นอีเมลของคุณ แล้วรันเฉพาะคำสั่งนี้
-- ============================================================
-- update public.profiles set
--   role      = 'admin',
--   active    = true,
--   full_name = 'ผู้ดูแลระบบ',
--   perms     = '{"dashboard":true,"scan":true,"calendar":true,"map":true,
--                 "docs":true,"vehicles":true,"reports":true,"users":true}'::jsonb
-- where lower(email) = lower('you@example.com');
