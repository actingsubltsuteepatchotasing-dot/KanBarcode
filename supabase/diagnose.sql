-- ============================================================
--  KanBarcode — ตรวจสอบว่าทำไมล็อกอินไม่ได้
--  รันใน Supabase → SQL Editor
--  รันทีละส่วน (ไฮไลต์เฉพาะส่วนที่ต้องการแล้วกด Run)
-- ============================================================


-- ============================================================
--  ส่วนที่ 1 — โครงสร้างครบไหม   (รันส่วนนี้ก่อนเสมอ)
--  ส่วนนี้ไม่แตะตาราง profiles จึงรันได้แม้ยังไม่ได้สร้างตาราง
-- ============================================================
select * from (values
  ('1. ตาราง public.profiles',
   case when to_regclass('public.profiles') is null
        then '❌ ยังไม่มี' else '✅ มีแล้ว' end,
   'ถ้าไม่มี → รัน supabase/schema.sql ทั้งไฟล์'),

  ('2. เปิด Row Level Security',
   coalesce((select case when relrowsecurity then '✅ เปิดอยู่' else '❌ ปิดอยู่' end
             from pg_class where oid = to_regclass('public.profiles')), '- ยังไม่มีตาราง'),
   'ถ้าปิด → รัน schema.sql ซ้ำ'),

  ('3. จำนวน RLS policy (ควรได้ 5)',
   (select count(*)::text from pg_policies
    where schemaname = 'public' and tablename = 'profiles'),
   'ถ้าไม่ครบ 5 → รัน schema.sql ซ้ำ'),

  ('4. สิทธิ์ระดับตารางของ role authenticated',
   coalesce((select string_agg(distinct lower(privilege_type), ', ' order by lower(privilege_type))
             from information_schema.role_table_grants
             where table_schema = 'public' and table_name = 'profiles'
               and grantee = 'authenticated'), '❌ ไม่มีเลย'),
   'ต้องมีอย่างน้อย select — ถ้าไม่มีจะขึ้น permission denied'),

  ('5. ฟังก์ชัน public.is_admin()',
   case when to_regprocedure('public.is_admin()') is null
        then '❌ ยังไม่มี' else '✅ มีแล้ว' end,
   'ถ้าไม่มี → รัน schema.sql ซ้ำ'),

  ('6. Trigger on_auth_user_created',
   case when exists (select 1 from pg_trigger
                     where tgname = 'on_auth_user_created' and not tgisinternal)
        then '✅ ติดตั้งแล้ว' else '❌ ยังไม่มี' end,
   'ถ้าไม่มี บัญชีที่สร้างใหม่จะไม่ได้แถวสิทธิ์'),

  ('7. จำนวนบัญชีใน auth.users',
   (select count(*)::text from auth.users),
   'ถ้าเป็น 0 → ยังไม่ได้สร้างบัญชีที่ Authentication → Users'),

  ('8. บัญชีที่ยังไม่ยืนยันอีเมล',
   (select count(*)::text from auth.users where email_confirmed_at is null),
   'ถ้ามี → กด Confirm ให้ หรือรันส่วนที่ 3 ข้อ B')
) as t("รายการตรวจ", "ผลลัพธ์", "ถ้าผิดให้ทำอะไร");


-- ============================================================
--  ส่วนที่ 2 — บัญชีแต่ละคนติดตรงไหน
--  รันได้เมื่อส่วนที่ 1 ข้อ 1 ขึ้น ✅ แล้วเท่านั้น
-- ============================================================
select
  u.email                                                        as "อีเมล",
  case when u.email_confirmed_at is null
       then '❌ ยังไม่ยืนยัน' else '✅ ยืนยันแล้ว' end             as "ยืนยันอีเมล",
  case when p.id is null
       then '❌ ไม่มีแถวสิทธิ์' else '✅ มี' end                    as "แถวใน profiles",
  coalesce(p.role, '-')                                          as "ระดับ",
  case when p.active then '✅ เปิดใช้งาน' else '❌ ปิด/ระงับ' end   as "สถานะ",
  case
    when p.id is null                 then 'รันส่วนที่ 3 ข้อ A (สร้างแถวสิทธิ์ย้อนหลัง)'
    when u.email_confirmed_at is null then 'รันส่วนที่ 3 ข้อ B (ยืนยันอีเมลให้)'
    when not p.active                 then 'รันส่วนที่ 3 ข้อ C (เปิดใช้งาน + ตั้งเป็น admin)'
    else                                   '✅ พร้อมใช้งาน — ล็อกอินได้'
  end                                                            as "ต้องทำอะไรต่อ"
from auth.users u
left join public.profiles p on p.id = u.id
order by u.created_at;


-- ============================================================
--  ส่วนที่ 3 — คำสั่งซ่อม
--  ลบ -- ข้างหน้าเฉพาะข้อที่ต้องใช้ แล้วรัน
-- ============================================================

-- ---- A. สร้างแถวสิทธิ์ให้บัญชีที่ยังไม่มี ------------------------
--    ใช้เมื่อสร้างบัญชี "ก่อน" รัน schema.sql (trigger ยังไม่ทันติดตั้ง)
--    นี่คือสาเหตุที่พบบ่อยที่สุด
--
-- insert into public.profiles (id, email, full_name, role, active, perms)
-- select u.id, u.email,
--        coalesce(nullif(u.raw_user_meta_data->>'full_name',''), split_part(u.email,'@',1)),
--        'user', false, '{}'::jsonb
-- from auth.users u
-- where not exists (select 1 from public.profiles p where p.id = u.id);


-- ---- B. ยืนยันอีเมลให้เอง --------------------------------------
--    ใช้เมื่อลืมติ๊ก Auto Confirm User ตอนสร้างบัญชี
--    (หรือกดปุ่ม Confirm ที่ Authentication → Users ก็ได้เหมือนกัน)
--
-- update auth.users
-- set email_confirmed_at = coalesce(email_confirmed_at, now())
-- where lower(email) = lower('you@example.com');


-- ---- C. ตั้งบัญชีเป็น admin และเปิดใช้งาน -----------------------
--
-- update public.profiles set
--   role      = 'admin',
--   active    = true,
--   full_name = 'ผู้ดูแลระบบ',
--   perms     = '{"dashboard":true,"scan":true,"calendar":true,"map":true,
--                 "docs":true,"vehicles":true,"reports":true,"users":true}'::jsonb
-- where lower(email) = lower('you@example.com');


-- ---- D. ทำ A + B + C รวดเดียวจบ --------------------------------
--    เปลี่ยนอีเมลทั้ง 3 จุดเป็นของคุณ แล้วไฮไลต์ทั้งบล็อกกด Run
--
-- insert into public.profiles (id, email, full_name, role, active, perms)
-- select u.id, u.email, split_part(u.email,'@',1), 'user', false, '{}'::jsonb
-- from auth.users u
-- where not exists (select 1 from public.profiles p where p.id = u.id);
--
-- update auth.users
-- set email_confirmed_at = coalesce(email_confirmed_at, now())
-- where lower(email) = lower('you@example.com');
--
-- update public.profiles set
--   role = 'admin', active = true, full_name = 'ผู้ดูแลระบบ',
--   perms = '{"dashboard":true,"scan":true,"calendar":true,"map":true,
--             "docs":true,"vehicles":true,"reports":true,"users":true}'::jsonb
-- where lower(email) = lower('you@example.com');
--
-- -- ตรวจผลอีกที
-- select email, role, active from public.profiles
-- where lower(email) = lower('you@example.com');


-- ---- E. ลืมรหัสผ่านของ admin -----------------------------------
--    ตั้งรหัสผ่านใหม่ไม่ได้จาก SQL — ให้ไปที่
--    Authentication → Users → คลิกที่บัญชี → Reset password
--    หรือกด "ลืมรหัสผ่าน" ที่หน้า login ของเว็บ
