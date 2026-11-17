begin;

create table if not exists assistant.schedule_series (
 family_id uuid not null references assistant.families(id),
 id uuid not null,
 version integer not null default 1 check (version > 0),
 title text not null check (length(trim(title)) between 1 and 300),
 kind text not null check (kind in ('appointment','event')),
 status text not null default 'active' check (status in ('active','cancelled')),
 timezone text not null,
 all_day boolean not null,
 start_date date,
 end_date_exclusive date,
 start_at timestamptz,
 end_at timestamptz,
 recurrence_raw text[] not null check (cardinality(recurrence_raw) > 0),
 edit_mode text not null default 'supported' check (edit_mode in ('supported','read_only')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key (family_id,id),
 check (
  (all_day and start_date is not null and end_date_exclusive > start_date and end_date_exclusive is not null
   and start_at is null and end_at is null) or
  (not all_day and start_at is not null and end_at > start_at and end_at is not null
   and start_date is null and end_date_exclusive is null)
 )
);

-- Existing rows retain their all_day flag and timing fields.
alter table assistant.schedule_series add column if not exists time_type text;
alter table assistant.schedule_series add column if not exists time_note text;
alter table assistant.schedule_series drop constraint if exists schedule_series_kind_check;
alter table assistant.schedule_series add constraint schedule_series_kind_check
 check (kind in ('appointment','event') or (kind='task' and time_type is not null and time_type='date_only'));
alter table assistant.schedule_series drop constraint if exists schedule_series_check;
alter table assistant.schedule_series add constraint schedule_series_check check (
 ((all_day or coalesce(time_type in ('unknown','condition','date_only'),false))
  and start_date is not null and end_date_exclusive is not null and end_date_exclusive > start_date
  and start_at is null and end_at is null) or
 (not all_day and not coalesce(time_type in ('unknown','condition','date_only'),false)
  and start_at is not null and (end_at is null or end_at > start_at)
  and start_date is null and end_date_exclusive is null)
);
alter table assistant.schedule_series drop constraint if exists schedule_series_time_type_check;
alter table assistant.schedule_series add constraint schedule_series_time_type_check check (
 (time_type is null or (
  time_type in ('all_day','timed','unknown','range','condition','date_only')
  and all_day = (time_type = 'all_day')
  and (time_type <> 'range' or end_at is not null)
  and (time_type <> 'condition' or nullif(trim(coalesce(time_note,'')),'') is not null)
 )) and (time_note is null or length(time_note) <= 300)
);

create table if not exists assistant.schedule_occurrences (
 family_id uuid not null,
 series_id uuid not null,
 anchor_key text not null,
 occurrence_id uuid not null,
 task_id uuid,
 original_timezone text not null,
 original_offset integer,
 original_start_at timestamptz,
 series_version integer not null check (series_version > 0),
 projection_state text not null default 'active' check (projection_state in ('active','excluded')),
 primary key (family_id,series_id,anchor_key),
 unique (family_id,occurrence_id),
 unique (family_id,task_id),
 foreign key (family_id,series_id) references assistant.schedule_series(family_id,id),
 foreign key (family_id,task_id) references assistant.tasks(family_id,id),
 check ((original_start_at is null) = (original_offset is null))
);

create table if not exists assistant.schedule_exceptions (
 family_id uuid not null,
 series_id uuid not null,
 anchor_key text not null,
 version integer not null check (version > 0),
 status text not null check (status in ('modified','cancelled')),
 overrides jsonb not null default '{}' check (jsonb_typeof(overrides)='object'),
 updated_at timestamptz not null default now(),
 primary key (family_id,series_id,anchor_key),
 foreign key (family_id,series_id,anchor_key) references assistant.schedule_occurrences(family_id,series_id,anchor_key)
);

create table if not exists assistant.schedule_series_history (
 id bigint generated always as identity primary key,
 family_id uuid not null,
 series_id uuid not null,
 anchor_key text,
 actor text not null,
 origin text not null,
 before_data jsonb,
 after_data jsonb,
 reason text not null,
 at timestamptz not null default now(),
 foreign key (family_id,series_id) references assistant.schedule_series(family_id,id),
 foreign key (family_id,series_id,anchor_key) references assistant.schedule_occurrences(family_id,series_id,anchor_key)
);
create index if not exists schedule_series_history_lookup on assistant.schedule_series_history(family_id,series_id,at);

create table if not exists assistant.calendar_sync_state (
 family_id uuid not null references assistant.families(id),
 id uuid not null,
 calendar_id text not null check (length(trim(calendar_id)) > 0 and calendar_id <> 'primary'),
 mode text not null default 'paused' check (mode in ('paused','preview','inbound','bidirectional')),
 sync_token text,
 query_version integer not null default 1 check (query_version > 0),
 sync_epoch bigint not null default 0,
 run_id uuid,
 next_page_token text,
 lease_owner uuid,
 lease_until timestamptz,
 last_success_at timestamptz,
 next_poll_at timestamptz,
 last_error_code text,
 primary key (family_id,id),
 unique (family_id),
 unique (calendar_id)
);

create table if not exists assistant.calendar_event_links (
 family_id uuid not null,
 connection_id uuid not null,
 google_event_id text not null,
 task_id uuid,
 series_id uuid,
 anchor_key text,
 google_parent_id text,
 original_start_key text,
 ical_uid text,
 last_seen_etag text,
 agreed_etag text,
 agreed_local_version jsonb,
 agreed_fields jsonb,
 remote_timing jsonb,
 visibility_policy text not null default 'standard',
 protected_payload bytea,
 status text not null default 'active' check (status in ('active','deleted','replaced')),
 previous_google_event_id text,
 deleted_at timestamptz,
 primary key (family_id,connection_id,google_event_id),
 foreign key (family_id,connection_id) references assistant.calendar_sync_state(family_id,id),
 foreign key (family_id,task_id) references assistant.tasks(family_id,id),
 foreign key (family_id,series_id) references assistant.schedule_series(family_id,id),
 foreign key (family_id,series_id,anchor_key) references assistant.schedule_occurrences(family_id,series_id,anchor_key),
 foreign key (family_id,connection_id,previous_google_event_id) references assistant.calendar_event_links(family_id,connection_id,google_event_id),
 check ((task_id is not null and series_id is null and anchor_key is null) or (task_id is null and series_id is not null)),
 check ((anchor_key is null and google_parent_id is null and original_start_key is null)
     or (anchor_key is not null and google_parent_id is not null and original_start_key is not null))
);
create unique index if not exists calendar_links_task on assistant.calendar_event_links(family_id,connection_id,task_id)
 where status='active' and task_id is not null;
create unique index if not exists calendar_links_series on assistant.calendar_event_links(family_id,connection_id,series_id)
 where status='active' and series_id is not null and anchor_key is null;
create unique index if not exists calendar_links_occurrence on assistant.calendar_event_links(family_id,connection_id,series_id,anchor_key)
 where status='active' and anchor_key is not null;
create unique index if not exists calendar_links_google_occurrence on assistant.calendar_event_links(family_id,connection_id,google_parent_id,original_start_key)
 where status='active' and google_parent_id is not null;

create table if not exists assistant.calendar_sync_inbox (
 family_id uuid not null,
 connection_id uuid not null,
 run_id uuid not null,
 google_event_id text not null,
 resource_kind text not null check (resource_kind in ('single','series','modified_occurrence','cancelled_occurrence','deleted')),
 etag text,
 payload jsonb not null,
 state text not null default 'pending' check (state in ('pending','applied','held','ignored')),
 result_code text,
 primary key (family_id,connection_id,run_id,google_event_id),
 foreign key (family_id,connection_id) references assistant.calendar_sync_state(family_id,id)
);

create table if not exists assistant.calendar_sync_outbox (
 family_id uuid not null,
 connection_id uuid not null,
 target_kind text not null check (target_kind in ('task','series','occurrence')),
 target_id uuid not null,
 source_version jsonb not null,
 operation text not null check (operation in ('create','update','cancel')),
 google_event_id text,
 expected_etag text,
 payload jsonb not null,
 state text not null default 'pending' check (state in ('pending','sending','uncertain','done','held','superseded','failed')),
 attempts integer not null default 0 check (attempts >= 0),
 next_attempt_at timestamptz not null default now(),
 lease_owner uuid,
 lease_until timestamptz,
 last_error_code text,
 primary key (family_id,connection_id,target_kind,target_id,source_version,operation),
 foreign key (family_id,connection_id) references assistant.calendar_sync_state(family_id,id)
);
create index if not exists calendar_outbox_pending on assistant.calendar_sync_outbox(family_id,connection_id,state,next_attempt_at);

create table if not exists assistant.calendar_sync_conflicts (
 family_id uuid not null,
 connection_id uuid not null,
 id uuid not null,
 target_kind text not null check (target_kind in ('task','series','occurrence')),
 target_id uuid not null,
 base_data jsonb,
 local_data jsonb,
 remote_data jsonb,
 local_version jsonb,
 remote_etag text,
 reason text not null,
 state text not null default 'open' check (state in ('open','resolved')),
 resolved_by text,
 resolved_at timestamptz,
 primary key (family_id,connection_id,id),
 foreign key (family_id,connection_id) references assistant.calendar_sync_state(family_id,id)
);
create unique index if not exists calendar_conflicts_open on assistant.calendar_sync_conflicts(family_id,connection_id,target_kind,target_id)
 where state='open';

revoke all on assistant.schedule_series,assistant.schedule_occurrences,assistant.schedule_exceptions,
 assistant.schedule_series_history,assistant.calendar_sync_state,assistant.calendar_event_links,
 assistant.calendar_sync_inbox,assistant.calendar_sync_outbox,assistant.calendar_sync_conflicts
 from public,anon,authenticated;
grant select,insert,update on assistant.schedule_series,assistant.schedule_occurrences,assistant.schedule_exceptions,
 assistant.calendar_sync_state,assistant.calendar_event_links,assistant.calendar_sync_inbox,
 assistant.calendar_sync_outbox,assistant.calendar_sync_conflicts to assistant_app;
grant select,insert on assistant.schedule_series_history to assistant_app;
grant usage,select on sequence assistant.schedule_series_history_id_seq to assistant_app;
commit;
