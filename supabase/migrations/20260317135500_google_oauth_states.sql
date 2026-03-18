create table if not exists public.google_oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  state text not null unique,
  origin text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.google_oauth_states enable row level security;

drop policy if exists "google_oauth_states_own_crud" on public.google_oauth_states;
create policy "google_oauth_states_own_crud"
on public.google_oauth_states for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "google_oauth_states_service_role" on public.google_oauth_states;
create policy "google_oauth_states_service_role"
on public.google_oauth_states for all to service_role
using (true)
with check (true);

create index if not exists google_oauth_states_user_idx on public.google_oauth_states(user_id);
create index if not exists google_oauth_states_expires_idx on public.google_oauth_states(expires_at);
