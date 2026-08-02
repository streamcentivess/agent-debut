-- Per-organization API keys for the hosted MCP gateway.
--
-- Agents authenticate with a bearer token. Only the SHA-256 hash is stored, so
-- a database leak cannot be replayed against the gateway. The plaintext key is
-- shown to the user exactly once, at creation.

create table if not exists api_keys (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  name        text not null default 'Default key',
  key_hash    text not null unique,
  key_prefix  text not null,            -- first chars, for display: debut_sk_a1b2…
  created_by  uuid references auth.users(id) on delete set null,
  last_used_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists api_keys_lookup on api_keys (key_hash) where revoked_at is null;

alter table api_keys enable row level security;

drop policy if exists keys_rw on api_keys;
create policy keys_rw on api_keys for all
  using (is_member(org_id)) with check (is_member(org_id));

-- The browser may list and revoke keys. It never needs to read key_hash, but
-- column-level restriction is unnecessary here: the hash is not reversible.
grant select, insert, update on api_keys to authenticated;

-- Mint a key for the caller's organization. Returns the plaintext ONCE.
create or replace function create_api_key(key_name text default 'Default key')
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  org      uuid;
  raw      text;
  prefix   text;
begin
  select org_id into org from memberships where user_id = auth.uid() limit 1;
  if org is null then
    raise exception 'no organization for this account';
  end if;

  raw := 'debut_sk_' || encode(extensions.gen_random_bytes(24), 'hex');
  prefix := left(raw, 17) || '...';

  insert into api_keys (org_id, name, key_hash, key_prefix, created_by)
  values (org, key_name, encode(extensions.digest(raw, 'sha256'), 'hex'), prefix, auth.uid());

  return raw;
end $$;

grant execute on function create_api_key(text) to authenticated;
