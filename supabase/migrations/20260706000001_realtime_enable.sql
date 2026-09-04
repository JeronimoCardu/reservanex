-- Enable Supabase Realtime for CRM tables.
-- Uses a safe DO block so re-running this migration never fails.
-- REPLICA IDENTITY FULL lets UPDATE/DELETE events carry the full old row,
-- which makes row-level filters on non-PK columns work reliably.

do $$
declare
  tables text[] := array['messages', 'conversations', 'notes', 'tasks'];
  t text;
begin
  foreach t in array tables loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname    = 'supabase_realtime'
        and schemaname = 'public'
        and tablename  = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

alter table public.messages      replica identity full;
alter table public.conversations replica identity full;
alter table public.notes         replica identity full;
alter table public.tasks         replica identity full;
