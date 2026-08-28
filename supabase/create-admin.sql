-- ============================================================
--  KanBarcode — สร้างบัญชี + รหัสผ่าน ให้เสร็จในคำสั่งเดียว
--  Supabase project : mxjdzpfxndspwdlobxha
--
--  ใช้แทนการกดสร้างผู้ใช้ทีละคนที่ Authentication → Users
--  สคริปต์นี้ทำครบทั้ง 3 อย่างในทีเดียว
--    1. สร้างบัญชีใน auth.users พร้อมรหัสผ่าน (ยืนยันอีเมลให้เลย)
--    2. สร้าง auth.identities ให้ (ขาดตัวนี้จะล็อกอินด้วยรหัสผ่านไม่ได้)
--    3. ตั้ง public.profiles ให้เป็น admin + active + เปิดสิทธิ์ทุกเมนู
--
--  วิธีใช้
--    1. รัน supabase/schema.sql ให้ครบก่อน (รันครั้งเดียวพอ)
--    2. แก้ค่า 3 บรรทัดในบล็อก "แก้ตรงนี้" ข้างล่าง
--    3. Supabase → SQL Editor → New query → วางทั้งไฟล์ → Run
--
--  รันซ้ำได้ปลอดภัย — ถ้ามีอีเมลนี้อยู่แล้วจะเป็นการ
--  "ตั้งรหัสผ่านใหม่ + คืนสิทธิ์ admin" ให้แทน (ใช้กู้รหัสผ่านที่ลืมได้)
-- ============================================================

create extension if not exists pgcrypto with schema extensions;
set search_path = public, extensions;

do $$
declare
  -- ==========================================================
  --  แก้ตรงนี้
  -- ==========================================================
  v_email    text := 'admin@kanbarcode.local';   -- อีเมลที่ใช้ล็อกอิน
  v_password text := 'ChangeMe#2026';            -- รหัสผ่าน (อย่างน้อย 8 ตัว)
  v_name     text := 'ผู้ดูแลระบบ';                -- ชื่อที่แสดงในเว็บ
  v_role     text := 'admin';                    -- 'admin' หรือ 'user'
  -- ==========================================================

  v_perms jsonb := '{"dashboard":true,"scan":true,"calendar":true,"map":true,
                     "docs":true,"vehicles":true,"reports":true,"users":true}'::jsonb;
  v_id       uuid;
  v_existing uuid;
  v_identity jsonb;
  v_new      boolean := false;
begin
  v_email := lower(trim(v_email));

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'รูปแบบอีเมลไม่ถูกต้อง: %', v_email;
  end if;
  if length(v_password) < 8 then
    raise exception 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร';
  end if;
  if v_role not in ('admin','user') then
    raise exception 'role ต้องเป็น admin หรือ user เท่านั้น';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'ยังไม่มีตาราง public.profiles — รัน supabase/schema.sql ก่อน';
  end if;

  select id into v_existing from auth.users where lower(email) = v_email;

  -- ---------- 1) บัญชีใน auth.users ----------
  if v_existing is null then
    v_new := true;
    v_id  := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      -- คอลัมน์ token ต้องเป็นสตริงว่าง ห้ามเป็น NULL
      -- ไม่งั้น GoTrue จะฟ้อง "converting NULL to string is unsupported" ตอนล็อกอิน
      confirmation_token, recovery_token, email_change, email_change_token_new,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token,
      is_super_admin, is_sso_user
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
      v_email, crypt(v_password, gen_salt('bf')),
      now(), now(), now(),
      jsonb_build_object('provider','email','providers', jsonb_build_array('email')),
      jsonb_build_object('full_name', v_name, 'email_verified', true),
      '', '', '', '',
      '', '', '', '',
      false, false
    );
  else
    v_id := v_existing;
    update auth.users set
      encrypted_password = crypt(v_password, gen_salt('bf')),
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      banned_until       = null,
      deleted_at         = null,
      raw_user_meta_data = coalesce(raw_user_meta_data,'{}'::jsonb)
                           || jsonb_build_object('full_name', v_name),
      updated_at         = now()
    where id = v_id;
  end if;

  -- ---------- 2) identity แบบ email ----------
  -- ถ้าไม่มีแถวนี้ Supabase จะตอบ "Invalid login credentials" ทั้งที่รหัสผ่านถูก
  v_identity := jsonb_build_object(
    'sub', v_id::text, 'email', v_email,
    'email_verified', true, 'phone_verified', false
  );

  if not exists (
    select 1 from auth.identities where user_id = v_id and provider = 'email'
  ) then
    -- โครงสร้าง auth.identities ต่างกันตามรุ่นของ GoTrue → เลือกตามคอลัมน์ที่มีจริง
    if exists (
      select 1 from information_schema.columns
      where table_schema='auth' and table_name='identities' and column_name='provider_id'
    ) then
      execute $q$
        insert into auth.identities
          (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        values (gen_random_uuid(), $1, $1::text, $2, 'email', now(), now(), now())
      $q$ using v_id, v_identity;
    else
      execute $q$
        insert into auth.identities
          (id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        values ($1::text, $1, $2, 'email', now(), now(), now())
      $q$ using v_id, v_identity;
    end if;
  else
    update auth.identities
       set identity_data = v_identity, updated_at = now()
     where user_id = v_id and provider = 'email';
  end if;

  -- ---------- 3) สิทธิ์ใน public.profiles ----------
  -- ตอน insert auth.users ทริกเกอร์ handle_new_user จะสร้างแถวเป็น user/false ไว้แล้ว
  -- ตรงนี้คือการเลื่อนขั้นเป็น admin + เปิดใช้งาน
  insert into public.profiles as pr (id, email, full_name, role, active, perms)
  values (v_id, v_email, v_name, v_role, true,
          case when v_role = 'admin' then v_perms else '{}'::jsonb end)
  on conflict (id) do update set
    email     = excluded.email,
    full_name = excluded.full_name,
    role      = excluded.role,
    active    = true,
    perms     = case when excluded.role = 'admin' then v_perms
                     else pr.perms end,
    updated_at = now();

  raise notice '% : %  (id=%)',
    case when v_new then 'สร้างบัญชีใหม่เรียบร้อย' else 'ตั้งรหัสผ่านใหม่เรียบร้อย' end,
    v_email, v_id;
end $$;


-- ============================================================
--  ตรวจผลลัพธ์ — ควรได้ ✅ ครบทั้ง 3 คอลัมน์
-- ============================================================
select
  p.email,
  p.full_name,
  p.role,
  case when p.active then '✅ เปิดใช้งาน' else '❌ ปิดอยู่' end                as active,
  case when u.encrypted_password is not null then '✅ มีรหัสผ่าน' else '❌ ไม่มี' end as password,
  case when u.email_confirmed_at is not null then '✅ ยืนยันแล้ว' else '❌ ยังไม่ยืนยัน' end as confirmed,
  case when i.user_id is not null then '✅ มี identity' else '❌ ล็อกอินไม่ได้' end as identity
from public.profiles p
join auth.users u on u.id = p.id
left join auth.identities i on i.user_id = p.id and i.provider = 'email'
order by p.role, p.email;
