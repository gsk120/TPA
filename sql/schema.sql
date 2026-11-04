-- 신규 개인비서 Supabase 프로젝트의 SQL Editor에서 한 번 실행합니다.
-- 이 파일은 애플리케이션 스키마와 최소 권한 로그인 역할만 만듭니다.
begin;
create schema if not exists assistant;
do $$ begin
  if not exists(select 1 from pg_roles where rolname='assistant_app') then
    create role assistant_app login nosuperuser nocreatedb nocreaterole noinherit;
  end if;
end $$;
revoke all on schema assistant from public, anon, authenticated;
grant usage on schema assistant to assistant_app;

create table if not exists assistant.families (
 id uuid primary key, chat_id text not null unique, user_ids text[] not null,
 created_at timestamptz not null default now(), constraint families_user_ids_nonempty check(cardinality(user_ids)>=1)
);
create table if not exists assistant.tasks (
 family_id uuid not null references assistant.families(id), id uuid not null,
 version integer not null check(version>0), data jsonb not null,
 primary key(family_id,id)
);
create table if not exists assistant.history (
 id bigint generated always as identity primary key,
 family_id uuid not null references assistant.families(id), actor text not null,
 task_id uuid not null, before_data jsonb, after_data jsonb not null,
 reason text not null default '', at timestamptz not null default now()
);
create index if not exists history_family_time on assistant.history(family_id,at desc);
create table if not exists assistant.jobs (
 family_id uuid not null references assistant.families(id), id text not null,
 payload jsonb not null, status text not null default 'pending' check(status in ('pending','running','done','failed')),
 attempts integer not null default 0, lease uuid, lease_until timestamptz,
 error text, created_at timestamptz not null default now(), finished_at timestamptz,
 primary key(family_id,id)
);
create index if not exists jobs_pending on assistant.jobs(family_id,status,created_at);
create table if not exists assistant.deliveries (
 family_id uuid not null references assistant.families(id), id text not null,
 text text not null, status text not null default 'pending' check(status in ('pending','sending','sent','uncertain','failed','cancelled')),
 attempts integer not null default 0, next_attempt timestamptz not null default now(),
 task_id uuid, task_version integer, result jsonb, created_at timestamptz not null default now(),
 primary key(family_id,id)
);
create index if not exists deliveries_pending on assistant.deliveries(family_id,status,next_attempt);
create table if not exists assistant.context (
 family_id uuid not null references assistant.families(id), id bigint generated always as identity,
 actor text not null, text text not null, reply_to text, at timestamptz not null default now(),
 primary key(family_id,id)
);
create table if not exists assistant.runtime (
 family_id uuid not null references assistant.families(id), key text not null, value jsonb not null,
 primary key(family_id,key)
);

-- 비공개 스키마: PostgREST 공개 스키마에 assistant를 추가하지 마세요.
revoke all on all tables in schema assistant from public, anon, authenticated;
revoke all on all sequences in schema assistant from public, anon, authenticated;
grant select,insert on assistant.families to assistant_app;
grant select,insert,update on assistant.tasks,assistant.jobs,assistant.deliveries,assistant.runtime to assistant_app;
grant select,insert on assistant.history to assistant_app;
grant select,insert,delete on assistant.context to assistant_app;
grant usage,select on all sequences in schema assistant to assistant_app;
commit;

-- 다음 단계: npm run setup으로 로컬에 생성되는 data/bootstrap.sql을
-- 같은 신규 프로젝트 SQL Editor에서 실행하여 전용 비밀번호를 설정합니다.
-- 서버 접속에는 postgres 관리자 대신 assistant_app 로그인 역할을 사용합니다.

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
