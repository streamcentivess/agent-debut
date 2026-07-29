-- Agent Debut control plane.
-- Run this once in the Supabase SQL editor for a new project.
-- Everything is org-scoped and protected by row-level security, so the browser
-- can talk to Postgres directly with only the publishable anon key.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- organizations
create table if not exists orgs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists memberships (
  org_id   uuid not null references orgs(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  role     text not null default 'owner' check (role in ('owner', 'admin', 'member')),
  primary key (org_id, user_id)
);

-- Give every new signup its own organization so nobody lands on an empty app.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare new_org uuid;
begin
  insert into orgs (name)
    values (coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)) || '''s team')
    returning id into new_org;
  insert into memberships (org_id, user_id, role) values (new_org, new.id, 'owner');
  insert into credit_balances (org_id, remaining, included) values (new_org, 500, 500);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function handle_new_user();

-- ------------------------------------------------------------ store connections
-- Credential FILES live in the private "store-credentials" storage bucket.
-- Only credential_path is kept here; the Mac worker reads the file with the
-- service role key. Secrets are never sent back to a browser or to a model.
create table if not exists store_connections (
  org_id                uuid not null references orgs(id) on delete cascade,
  provider              text not null check (provider in ('apple', 'google')),
  status                text not null default 'active' check (status in ('active', 'revoked', 'error')),
  key_id                text,
  issuer_id             text,
  service_account_email text,
  credential_path       text not null,
  connected_at          timestamptz not null default now(),
  primary key (org_id, provider)
);

-- ------------------------------------------------------------------------ apps
create table if not exists apps (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  name         text not null,
  bundle_id    text not null,
  icon         text default '📱',
  platforms    text[] not null default '{ios}',
  status       text not null default 'draft'
               check (status in ('draft','building','ready','review','live','rejected')),
  version      text default '1.0',
  stage        int  not null default 0 check (stage between 0 and 4),
  repo_url     text,
  asc_app_id   text,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (org_id, bundle_id)
);

-- Findings from store_readiness_check, one row per issue.
create table if not exists readiness_checks (
  id         uuid primary key default gen_random_uuid(),
  app_id     uuid not null references apps(id) on delete cascade,
  ok         boolean not null,
  title      text not null,
  detail     text,
  severity   text default 'warning' check (severity in ('blocker','warning','info')),
  created_at timestamptz not null default now()
);

-- --------------------------------------------------------------------- activity
create table if not exists activity (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  app_id     uuid references apps(id) on delete cascade,
  kind       text not null default 'info' check (kind in ('ok','warn','err','info')),
  message    text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------- credits
create table if not exists credit_balances (
  org_id     uuid primary key references orgs(id) on delete cascade,
  remaining  int not null default 500,
  included   int not null default 500,
  updated_at timestamptz not null default now()
);

create table if not exists credit_ledger (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  delta      int not null,
  reason     text not null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------- job queue (Macs)
-- The Mac worker polls this table for work the MCP server enqueued.
create table if not exists jobs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  app_id       uuid references apps(id) on delete cascade,
  tool         text not null,
  args         jsonb not null default '{}',
  status       text not null default 'queued'
               check (status in ('queued','running','done','failed','cancelled')),
  result       jsonb,
  error        text,
  claimed_by   text,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists jobs_pending on jobs (status, created_at) where status = 'queued';

-- ------------------------------------------------------------------------- RLS
alter table orgs              enable row level security;
alter table memberships       enable row level security;
alter table store_connections enable row level security;
alter table apps              enable row level security;
alter table readiness_checks  enable row level security;
alter table activity          enable row level security;
alter table credit_balances   enable row level security;
alter table credit_ledger     enable row level security;
alter table jobs              enable row level security;

create or replace function is_member(target uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from memberships m
    where m.org_id = target and m.user_id = auth.uid()
  );
$$;

do $$
declare t text;
begin
  foreach t in array array['store_connections','apps','activity','credit_balances','credit_ledger','jobs']
  loop
    execute format('drop policy if exists org_rw on %I', t);
    execute format(
      'create policy org_rw on %I for all using (is_member(org_id)) with check (is_member(org_id))', t);
  end loop;
end $$;

drop policy if exists org_read on orgs;
create policy org_read on orgs for select using (is_member(id));

drop policy if exists own_memberships on memberships;
create policy own_memberships on memberships for select using (user_id = auth.uid());

drop policy if exists checks_rw on readiness_checks;
create policy checks_rw on readiness_checks for all
  using (exists (select 1 from apps a where a.id = app_id and is_member(a.org_id)))
  with check (exists (select 1 from apps a where a.id = app_id and is_member(a.org_id)));

-- ---------------------------------------------------------------------- grants
-- The project has "automatically expose new tables" turned OFF, so access is
-- granted deliberately, one table at a time. Grants are the outer gate and the
-- RLS policies above are the row filter: a caller needs both to read anything.
--
-- Note what is missing here on purpose. `jobs` and `credit_ledger` are never
-- exposed to the browser; only the Mac worker touches them, using the service
-- role key, which bypasses both grants and RLS.
grant usage on schema public to anon, authenticated;

grant select on orgs, memberships, apps, readiness_checks, activity, credit_balances
  to authenticated;
grant select, insert, update on store_connections to authenticated;

-- Anything added later needs its own grant, or the dashboard will connect
-- successfully and then see an empty result.

-- --------------------------------------------------------------------- storage
-- Private bucket for .p8 and service-account files.
insert into storage.buckets (id, name, public)
  values ('store-credentials', 'store-credentials', false)
  on conflict (id) do nothing;

drop policy if exists creds_rw on storage.objects;
create policy creds_rw on storage.objects for all
  using (
    bucket_id = 'store-credentials'
    and is_member(((storage.foldername(name))[1])::uuid)
  )
  with check (
    bucket_id = 'store-credentials'
    and is_member(((storage.foldername(name))[1])::uuid)
  );
