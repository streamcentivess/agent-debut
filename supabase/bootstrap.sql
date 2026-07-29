-- Self-healing organization bootstrap.
--
-- The signup trigger in schema.sql only fires for accounts created after it
-- exists, so anyone who signed up earlier ends up with no organization and an
-- empty dashboard. This function closes that gap: it is idempotent, safe to
-- call on every dashboard load, and returns the caller's org either way.
--
-- Run this once in the SQL editor. It is additive and does not touch the
-- tables created by schema.sql.

create or replace function bootstrap_org()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  caller  uuid := auth.uid();
  existing uuid;
  fresh    uuid;
  label    text;
begin
  if caller is null then
    raise exception 'not signed in';
  end if;

  -- already has one? hand it back, change nothing.
  select org_id into existing from memberships where user_id = caller limit 1;
  if existing is not null then
    return existing;
  end if;

  select coalesce(
           nullif(raw_user_meta_data->>'full_name', ''),
           split_part(email, '@', 1),
           'My')
    into label
    from auth.users where id = caller;

  insert into orgs (name) values (label || '''s team') returning id into fresh;
  insert into memberships (org_id, user_id, role) values (fresh, caller, 'owner');
  insert into credit_balances (org_id, remaining, included) values (fresh, 500, 500)
    on conflict (org_id) do nothing;
  insert into activity (org_id, kind, message)
    values (fresh, 'ok', 'Welcome to Debut. You have 500 credits to start with.');

  return fresh;
end $$;

grant execute on function bootstrap_org() to authenticated;

-- Make sure the original trigger is in place for everyone who signs up next.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function handle_new_user();
