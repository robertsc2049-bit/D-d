-- Solo Adventure Engine storage.
-- Only the Edge Function (service key) reads or writes these tables: RLS is on with no policies,
-- and the public API roles get no privileges at all.

create table if not exists public.campaigns (
  id text primary key,
  name text not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists campaigns_updated_at_idx on public.campaigns (updated_at desc);

create table if not exists public.app_config (
  key text primary key,
  value text not null
);

alter table public.campaigns enable row level security;
alter table public.app_config enable row level security;
revoke all on public.campaigns, public.app_config from anon, authenticated;

-- Secret key that must appear in the MCP URL (64 random hex characters).
insert into public.app_config (key, value)
values ('access_key', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;
