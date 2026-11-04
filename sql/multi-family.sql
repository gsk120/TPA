-- TPA SQL Editor에서 postgres 역할로 실행. 데이터 삭제 없음.
begin;
alter table assistant.families add column if not exists settings jsonb not null default '{}';
alter table assistant.families add column if not exists settings_version integer not null default 1;
alter table assistant.families add column if not exists active boolean not null default false;
alter table assistant.families add column if not exists setup_actor text;
alter table assistant.families add column if not exists bot_event bigint not null default -1;
create table if not exists assistant.members (
 family_id uuid not null references assistant.families(id), user_id text not null,
 active boolean not null, event_id bigint not null default -1, checked_at timestamptz not null default now(),
 primary key(family_id,user_id)
);
create table if not exists assistant.settings_history (
 id bigint generated always as identity primary key, family_id uuid not null references assistant.families(id),
 actor text not null,before_data jsonb not null,after_data jsonb not null,at timestamptz not null default now()
);
create table if not exists assistant.bot_runtime (bot_id text primary key, offset_id bigint not null default 0);
revoke all on assistant.members,assistant.settings_history,assistant.bot_runtime from public,anon,authenticated;
grant select,insert,update on assistant.families,assistant.members,assistant.bot_runtime to assistant_app;
grant select,insert on assistant.settings_history to assistant_app;
grant usage,select on all sequences in schema assistant to assistant_app;
commit;
