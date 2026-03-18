alter table public.files
add column if not exists vendors_found_count integer not null default 0;
