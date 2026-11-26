-- Append-only event ledger + GitHub mirror bookkeeping.
-- Every state change and its ledger entries are written in ONE transaction (commit_campaign),
-- so the saved state and the ledger can never disagree.

alter table public.campaigns add column if not exists last_seq bigint not null default 0;

create table if not exists public.events (
  campaign_id text not null references public.campaigns (id) on delete cascade,
  seq bigint not null,
  at timestamptz not null default now(),
  type text not null,
  summary text not null,
  data jsonb,
  primary key (campaign_id, seq)
);

create table if not exists public.mirror_state (
  campaign_id text primary key references public.campaigns (id) on delete cascade,
  last_seq bigint not null default 0,
  last_commit text,
  last_synced_at timestamptz,
  last_error text
);

alter table public.events enable row level security;
alter table public.mirror_state enable row level security;
revoke all on public.events, public.mirror_state from anon, authenticated;

-- Compare-and-set save of a campaign plus its new ledger entries.
-- Returns {"rev": n, "lastSeq": n} or NULL if the campaign changed since p_expected_rev was loaded.
create or replace function public.commit_campaign(
  p_id text, p_expected_rev integer, p_name text, p_data jsonb, p_updated_at timestamptz, p_events jsonb
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_count integer := coalesce(jsonb_array_length(p_events), 0);
  v_rev integer;
  v_last bigint;
  v_seq bigint;
  e jsonb;
begin
  update campaigns
     set rev = rev + 1,
         name = p_name,
         data = p_data || jsonb_build_object('rev', rev + 1, 'lastSeq', last_seq + v_count),
         updated_at = p_updated_at,
         last_seq = last_seq + v_count
   where id = p_id and rev = p_expected_rev
  returning rev, last_seq into v_rev, v_last;
  if not found then
    return null;
  end if;
  v_seq := v_last - v_count;
  for e in select value from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    v_seq := v_seq + 1;
    insert into events (campaign_id, seq, at, type, summary, data)
    values (p_id, v_seq, coalesce((e ->> 'at')::timestamptz, now()), e ->> 'type', e ->> 'summary', e -> 'data');
  end loop;
  return jsonb_build_object('rev', v_rev, 'lastSeq', v_last);
end;
$$;

revoke all on function public.commit_campaign(text, integer, text, jsonb, timestamptz, jsonb) from public, anon, authenticated;
