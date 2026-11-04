-- 기존 TPA 프로젝트 SQL Editor에서 관리자 권한으로 한 번 실행합니다.
begin;
alter table assistant.families drop constraint if exists families_user_ids_check;
alter table assistant.families drop constraint if exists families_user_ids_nonempty;
alter table assistant.families add constraint families_user_ids_nonempty check(cardinality(user_ids)>=1);
commit;
