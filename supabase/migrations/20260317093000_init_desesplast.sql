-- ===========================================
-- Core enums
-- ===========================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum ('admin', 'user');
  end if;
  if not exists (select 1 from pg_type where typname = 'company_type') then
    create type public.company_type as enum ('americana', 'days', 'desesplast');
  end if;
  if not exists (select 1 from pg_type where typname = 'file_status') then
    create type public.file_status as enum ('pending', 'processing', 'completed', 'error');
  end if;
  if not exists (select 1 from pg_type where typname = 'module_type') then
    create type public.module_type as enum ('cuentas_corrientes', 'fichadas', 'boletas');
  end if;
end $$;

create extension if not exists pgcrypto;

-- ===========================================
-- Tables
-- ===========================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null default 'user',
  created_at timestamptz not null default now(),
  unique(user_id, role)
);

create table if not exists public.configurations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, key)
);

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  module public.module_type not null,
  company_type public.company_type,
  status public.file_status not null default 'pending',
  file_path text not null,
  vendor_folder_path text,
  original_filename text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists files_user_module_idx on public.files(user_id, module);
create index if not exists files_vendor_folder_path_idx on public.files(vendor_folder_path);

create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  normalized_name text not null,
  original_name text,
  canonical_name text,
  company_type public.company_type,
  email text,
  drive_folder_id text,
  convert_to_pdf boolean not null default false,
  access_token text unique,
  vendor_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, normalized_name, company_type)
);

create index if not exists vendors_user_idx on public.vendors(user_id);
create index if not exists vendors_access_token_idx on public.vendors(access_token);
create index if not exists vendors_vendor_number_idx on public.vendors(vendor_number);

create table if not exists public.processes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  file_id uuid not null references public.files(id) on delete cascade,
  records_processed integer not null default 0,
  result_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists processes_user_idx on public.processes(user_id);
create index if not exists processes_file_idx on public.processes(file_id);

create table if not exists public.boleta_analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  file_id uuid not null references public.files(id) on delete cascade,
  vendor_id uuid references public.vendors(id) on delete set null,
  vendor_number text,
  analysis_text text,
  extracted_data jsonb,
  confidence_score numeric(4,3) not null default 0.850,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists boleta_analyses_user_idx on public.boleta_analyses(user_id);
create index if not exists boleta_analyses_vendor_number_idx on public.boleta_analyses(vendor_number);

create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activities_user_idx on public.activities(user_id);

create table if not exists public.google_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  access_token text not null,
  refresh_token text,
  token_type text,
  expires_at timestamptz,
  scope text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ===========================================
-- Triggers / Functions
-- ===========================================
create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;

  insert into public.user_roles (user_id, role)
  values (new.id, 'user')
  on conflict (user_id, role) do nothing;

  return new;
end;
$$;

create or replace function public.generate_vendor_access_token()
returns trigger
language plpgsql
as $$
begin
  if new.access_token is null then
    new.access_token := encode(gen_random_bytes(24), 'hex');
  end if;
  return new;
end;
$$;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    where ur.user_id = _user_id
      and ur.role = _role
  );
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

drop trigger if exists trg_vendors_generate_access_token on public.vendors;
create trigger trg_vendors_generate_access_token
before insert on public.vendors
for each row execute procedure public.generate_vendor_access_token();

do $$
declare
  t text;
begin
  foreach t in array array['profiles','configurations','files','vendors','processes','boleta_analyses','activities','google_oauth_tokens','user_roles']
  loop
    execute format('drop trigger if exists trg_%s_updated_at on public.%s;', t, t);
    if t <> 'activities' then
      execute format('create trigger trg_%s_updated_at before update on public.%s for each row execute procedure public.update_updated_at_column();', t, t);
    end if;
  end loop;
end $$;

-- ===========================================
-- RLS
-- ===========================================
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.configurations enable row level security;
alter table public.files enable row level security;
alter table public.vendors enable row level security;
alter table public.processes enable row level security;
alter table public.boleta_analyses enable row level security;
alter table public.activities enable row level security;
alter table public.google_oauth_tokens enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles for select
using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles for update
using (auth.uid() = id);

drop policy if exists "user_roles_select_own" on public.user_roles;
create policy "user_roles_select_own"
on public.user_roles for select
using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'));

drop policy if exists "user_roles_admin_manage" on public.user_roles;
create policy "user_roles_admin_manage"
on public.user_roles for all
using (public.has_role(auth.uid(), 'admin'))
with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists "configurations_own_crud" on public.configurations;
create policy "configurations_own_crud"
on public.configurations for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "files_own_crud" on public.files;
create policy "files_own_crud"
on public.files for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "files_portal_read" on public.files;
create policy "files_portal_read"
on public.files for select to anon
using (vendor_folder_path is not null);

drop policy if exists "vendors_own_crud" on public.vendors;
create policy "vendors_own_crud"
on public.vendors for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "vendors_portal_read" on public.vendors;
create policy "vendors_portal_read"
on public.vendors for select to anon
using (access_token is not null);

drop policy if exists "processes_own_crud" on public.processes;
create policy "processes_own_crud"
on public.processes for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "boleta_analyses_own_crud" on public.boleta_analyses;
create policy "boleta_analyses_own_crud"
on public.boleta_analyses for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "activities_own_crud" on public.activities;
create policy "activities_own_crud"
on public.activities for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "google_oauth_tokens_own_crud" on public.google_oauth_tokens;
create policy "google_oauth_tokens_own_crud"
on public.google_oauth_tokens for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "google_oauth_tokens_service_role" on public.google_oauth_tokens;
create policy "google_oauth_tokens_service_role"
on public.google_oauth_tokens for all to service_role
using (true)
with check (true);

-- ===========================================
-- Storage buckets (idempotent)
-- ===========================================
insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('results', 'results', false)
on conflict (id) do nothing;
