-- When the worker opened each thing on GitHub for a request group.
--
-- The console bell lists the issue and the pull request a group has, newest first, and counts
-- the ones the reader has not opened yet. It used to date both by `last_seen`, which is when a
-- visitor last reported the gap, not when anything was opened. A pull request therefore carried
-- the date of the report that started its run: it sorted below a newer report's issue, and it
-- could look older than the moment the reader last opened the bell.
--
-- The two columns below are stamped by the database whenever the URL they belong to changes, so
-- every writer (the Python worker, the forge engine, a reset) gets them right without knowing
-- they exist. `opened_at` is the later of the two, so the bell can ask for the groups with the
-- newest GitHub activity in one ordered read.
alter table feature_request_group
  add column if not exists issue_opened_at timestamptz,
  add column if not exists pr_opened_at timestamptz;

create or replace function stamp_group_opened_at() returns trigger
language plpgsql as $$
begin
  if new.issue_url is null or new.issue_url = '' then
    new.issue_opened_at := null;
  elsif tg_op = 'INSERT' or new.issue_url is distinct from old.issue_url then
    new.issue_opened_at := now();
  end if;

  if new.pr_url is null or new.pr_url = '' then
    new.pr_opened_at := null;
  elsif tg_op = 'INSERT' or new.pr_url is distinct from old.pr_url then
    new.pr_opened_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists feature_request_group_opened_at on feature_request_group;
create trigger feature_request_group_opened_at
  before insert or update of issue_url, pr_url on feature_request_group
  for each row execute function stamp_group_opened_at();

-- Rows that already link to GitHub: the trace row of the call that opened the thing is the best
-- record of when it happened, and `last_seen` is the old behaviour when there is no such row.
update feature_request_group g
set issue_opened_at = coalesce(
  (select min(t.created_at)
     from trace_event t
     join escalation e on e.id = t.escalation_id
    where e.group_id = g.id
      and t.kind = 'tool'
      and t.detail->>'tool' in ('create_issue', 'issue_write')),
  g.last_seen)
where g.issue_url is not null and g.issue_url <> '' and g.issue_opened_at is null;

update feature_request_group g
set pr_opened_at = coalesce(
  (select max(t.created_at)
     from trace_event t
     join escalation e on e.id = t.escalation_id
    where e.group_id = g.id
      and t.kind = 'tool'
      and t.detail->>'tool' = 'create_pull_request'),
  g.last_seen)
where g.pr_url is not null and g.pr_url <> '' and g.pr_opened_at is null;

alter table feature_request_group
  add column if not exists opened_at timestamptz
  generated always as (greatest(issue_opened_at, pr_opened_at)) stored;

create index if not exists feature_request_group_opened_idx
  on feature_request_group (project_id, opened_at desc nulls last);

comment on column feature_request_group.issue_opened_at is
  'When issue_url was last set. Stamped by trigger feature_request_group_opened_at.';
comment on column feature_request_group.pr_opened_at is
  'When pr_url was last set. Stamped by trigger feature_request_group_opened_at.';
comment on column feature_request_group.opened_at is
  'The newest of issue_opened_at and pr_opened_at: when the worker last opened something on GitHub.';
