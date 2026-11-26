-- Revision number for optimistic concurrency: a save only applies if rev still matches
-- the revision that was loaded, so simultaneous actions can't overwrite each other.
alter table public.campaigns add column if not exists rev integer not null default 0;
