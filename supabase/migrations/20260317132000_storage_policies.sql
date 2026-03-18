-- Storage policies for internal admin app
-- NOTE: Permisivas para usuarios autenticados. Endurecer por carpeta user_id en hardening final.

drop policy if exists "storage_uploads_auth_crud" on storage.objects;
create policy "storage_uploads_auth_crud"
on storage.objects
for all
to authenticated
using (bucket_id = 'uploads')
with check (bucket_id = 'uploads');

drop policy if exists "storage_results_auth_crud" on storage.objects;
create policy "storage_results_auth_crud"
on storage.objects
for all
to authenticated
using (bucket_id = 'results')
with check (bucket_id = 'results');

drop policy if exists "storage_uploads_service_role" on storage.objects;
create policy "storage_uploads_service_role"
on storage.objects
for all
to service_role
using (bucket_id = 'uploads')
with check (bucket_id = 'uploads');

drop policy if exists "storage_results_service_role" on storage.objects;
create policy "storage_results_service_role"
on storage.objects
for all
to service_role
using (bucket_id = 'results')
with check (bucket_id = 'results');
