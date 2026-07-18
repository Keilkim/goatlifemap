-- 운영 감사·수집 변경 후보·포인트 원장.
--
-- 현재값만 바꾸면 "무엇이 언제 왜 바뀌었나"를 복구할 수 없다. 이 마이그레이션은
-- 모든 stores/menus 변경을 사람이 읽을 수 있는 이벤트로 자동 기록하고, 수집기가
-- 발견한 폐업·단종·가격 차이는 바로 덮어쓰지 않고 운영자 확인 후보로 쌓는다.

-- 운영자가 한 번 본 뒤 의도적으로 미룬 항목은 새 pending과 구분한다.
alter table menu_verifications drop constraint if exists menu_verifications_status_check;
alter table menu_verifications add constraint menu_verifications_status_check
  check (status in ('pending', 'held', 'approved', 'rejected'));
alter table menu_verifications
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by text;

alter table menu_reviews drop constraint if exists menu_reviews_status_check;
alter table menu_reviews add constraint menu_reviews_status_check
  check (status in ('pending', 'held', 'approved', 'rejected'));
alter table menu_reviews
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by text;

-- 한 번의 외부 데이터 확인이 완전했는지 남긴다. 실패·부분 실행은 사라짐 판정에
-- 사용하지 않는다.
create table if not exists ingestion_runs (
  id               uuid primary key default gen_random_uuid(),
  source           text not null,
  scope            text not null,
  full_snapshot    boolean not null default false,
  status           text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  records_seen     integer not null default 0,
  changes_detected integer not null default 0,
  stats            jsonb not null default '{}'::jsonb,
  error_text       text,
  started_at       timestamptz not null default now(),
  completed_at     timestamptz
);

create index if not exists ingestion_runs_source_time_idx
  on ingestion_runs (source, scope, started_at desc);

-- 통합 변화 기록.
-- pending/held는 수집기가 발견했지만 아직 현재값에 반영하지 않은 후보이고,
-- confirmed는 실제 반영된 변화다. summary가 관리자 화면에 그대로 보이는 텍스트다.
create table if not exists data_change_events (
  id               uuid primary key default gen_random_uuid(),
  entity_type      text not null check (entity_type in ('store', 'menu')),
  entity_id        uuid not null,
  store_id         uuid,
  menu_id          uuid,
  event_type       text not null,
  status           text not null default 'confirmed'
    check (status in ('pending', 'held', 'confirmed', 'rejected')),
  summary          text not null,
  old_value        jsonb,
  new_value        jsonb,
  source           text not null,
  actor            text,
  ingest_run_id    uuid references ingestion_runs(id) on delete set null,
  verification_id  uuid references menu_verifications(id) on delete set null,
  dedupe_key       text,
  detected_at      timestamptz not null default now(),
  reviewed_at      timestamptz,
  confirmed_at     timestamptz,
  decision_note    text
);

create index if not exists data_change_events_pending_idx
  on data_change_events (detected_at)
  where status in ('pending', 'held');
create index if not exists data_change_events_entity_idx
  on data_change_events (entity_type, entity_id, detected_at desc);
create index if not exists data_change_events_run_idx
  on data_change_events (ingest_run_id);
-- 같은 미처리 후보를 수집할 때마다 중복 생성하지 않는다. 상태가 확정/거부되면
-- 나중에 같은 변화가 다시 생겼을 때 새 후보를 만들 수 있다.
create unique index if not exists data_change_events_open_dedupe_idx
  on data_change_events (dedupe_key)
  where dedupe_key is not null and status in ('pending', 'held');

-- 잔액(app_users.points)과 별개로 지급 사유·대상·시각을 보존한다.
create table if not exists point_transactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references app_users(id) on delete restrict,
  amount           integer not null check (amount <> 0),
  reason           text not null,
  reference_type   text,
  reference_id     uuid,
  idempotency_key  text not null unique,
  balance_after    integer not null,
  created_at       timestamptz not null default now()
);

create index if not exists point_transactions_user_time_idx
  on point_transactions (user_id, created_at desc);

-- migrate-first 무중단 배포 중 잠시 남아 있는 구버전 API는 app_users.points만 직접
-- 올린다. 같은 트랜잭션에 정확히 대응하는 원장이 없을 때만 자동 보충한다. 신버전은
-- 원장을 먼저 INSERT하고 잔액을 바꾸므로 이 trigger가 중복 행을 만들지 않는다.
create or replace function audit_unledgered_points_change()
returns trigger
language plpgsql
as $$
declare
  current_xid text;
  contribution_id uuid;
  contribution_type text;
  contribution_reason text;
begin
  if old.points is not distinct from new.points then return new; end if;
  current_xid := pg_current_xact_id()::text;

  if exists (
    select 1 from point_transactions p
    where p.user_id = new.id
      and p.amount = new.points - old.points
      and p.balance_after = new.points
      and p.xmin::text = current_xid
  ) then
    return new;
  end if;

  select v.id, 'menu_verification', 'legacy_verification_immediate'
  into contribution_id, contribution_type, contribution_reason
  from menu_verifications v
  where v.user_id = new.id and v.xmin::text = current_xid
  order by v.created_at desc
  limit 1;

  if contribution_id is null then
    select r.id, 'menu_review', 'legacy_review_immediate'
    into contribution_id, contribution_type, contribution_reason
    from menu_reviews r
    where r.user_id = new.id and r.xmin::text = current_xid
    order by r.created_at desc
    limit 1;
  end if;

  if contribution_reason is null then
    contribution_type := 'database_update';
    contribution_reason := 'direct_points_adjustment';
  end if;

  insert into point_transactions
    (user_id, amount, reason, reference_type, reference_id, idempotency_key, balance_after)
  values
    (new.id, new.points - old.points, contribution_reason, contribution_type, contribution_id,
     format('direct:%s:%s:%s:%s', current_xid, new.id, old.points, new.points), new.points)
  on conflict (idempotency_key) do nothing;
  return new;
end;
$$;

drop trigger if exists audit_unledgered_points_change_trigger on app_users;
create trigger audit_unledgered_points_change_trigger
after update of points on app_users
for each row execute function audit_unledgered_points_change();

-- CREATE TRIGGER가 app_users의 동시 UPDATE와 충돌하는 잠금을 먼저 잡은 뒤 기초 잔액을
-- 스냅샷한다. 이미 진행 중인 구버전 지급은 기다렸다가 opening에 포함되고, 이후 지급은
-- migration commit 뒤 활성화된 trigger가 받아 전환 순간에도 원장 공백이 없다.
insert into point_transactions
  (user_id, amount, reason, reference_type, idempotency_key, balance_after)
select id, points, 'opening_balance', 'migration', 'opening:' || id::text, points
from app_users
where points <> 0
on conflict (idempotency_key) do nothing;

-- 과거 마이그레이션을 재실행해도 최초 가격 행이 중복되지 않도록 먼저 정리하고
-- 메뉴당 최초 행 하나만 허용한다.
delete from menu_price_history h
where h.old_price is null
  and exists (
    select 1 from menu_price_history older
    where older.menu_id = h.menu_id and older.old_price is null
      and (older.changed_at, older.id::text) < (h.changed_at, h.id::text)
  );
create unique index if not exists menu_price_history_initial_unique
  on menu_price_history (menu_id) where old_price is null;

-- 트랜잭션 안에서 set_config('app.change_source', ...)로 실제 변경 경로를 넘긴다.
-- 설정이 없는 직접 SQL도 행의 source 또는 database로 빠져 이력이 끊기지 않는다.
create or replace function audit_context_uuid(setting_name text)
returns uuid
language plpgsql
stable
as $$
declare
  raw text;
begin
  raw := nullif(current_setting(setting_name, true), '');
  if raw is null then return null; end if;
  return raw::uuid;
exception when others then
  return null;
end;
$$;

create or replace function audit_stores_change()
returns trigger
language plpgsql
as $$
declare
  src text;
  run_id uuid;
  candidate_id uuid;
begin
  src := coalesce(nullif(current_setting('app.change_source', true), ''),
                  case when tg_op = 'DELETE' then old.source else new.source end,
                  'database');
  run_id := audit_context_uuid('app.ingestion_run_id');
  candidate_id := audit_context_uuid('app.change_candidate_id');

  -- 후보 승인으로 생긴 실제 변경은 그 후보 행 자체를 confirmed로 바꾸므로 중복 기록하지 않는다.
  if candidate_id is not null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    insert into data_change_events
      (entity_type, entity_id, store_id, event_type, summary, new_value, source, actor,
       ingest_run_id, confirmed_at)
    values
      ('store', new.id, new.id, 'store_created', format('가게 "%s" 등록', new.name),
       jsonb_build_object('name', new.name, 'is_open', new.is_open, 'address', new.road_address),
       src, src, run_id, now());
    return new;
  end if;

  if tg_op = 'DELETE' then
    insert into data_change_events
      (entity_type, entity_id, store_id, event_type, summary, old_value, source, actor,
       ingest_run_id, confirmed_at)
    values
      ('store', old.id, old.id, 'store_deleted', format('가게 "%s" 삭제', old.name),
       jsonb_build_object('name', old.name, 'is_open', old.is_open, 'address', old.road_address),
       src, src, run_id, now());
    return old;
  end if;

  if old.is_open is distinct from new.is_open then
    insert into data_change_events
      (entity_type, entity_id, store_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, confirmed_at)
    values
      ('store', new.id, new.id,
       case when new.is_open then 'store_reopened' else 'store_closed' end,
       format('가게 "%s" %s', new.name, case when new.is_open then '영업 재개' else '영업 종료' end),
       jsonb_build_object('is_open', old.is_open), jsonb_build_object('is_open', new.is_open),
       src, src, run_id, now());
  end if;

  if old.name is distinct from new.name then
    insert into data_change_events
      (entity_type, entity_id, store_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, confirmed_at)
    values
      ('store', new.id, new.id, 'store_renamed',
       format('가게 이름 변경: "%s" → "%s"', old.name, new.name),
       jsonb_build_object('name', old.name), jsonb_build_object('name', new.name),
       src, src, run_id, now());
  end if;

  if old.road_address is distinct from new.road_address then
    insert into data_change_events
      (entity_type, entity_id, store_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, confirmed_at)
    values
      ('store', new.id, new.id, 'store_address_changed',
       format('가게 "%s" 주소 변경: "%s" → "%s"', new.name,
              coalesce(old.road_address, '없음'), coalesce(new.road_address, '없음')),
       jsonb_build_object('road_address', old.road_address),
       jsonb_build_object('road_address', new.road_address),
       src, src, run_id, now());
  end if;

  if old.category is distinct from new.category then
    insert into data_change_events
      (entity_type, entity_id, store_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, confirmed_at)
    values
      ('store', new.id, new.id, 'store_category_changed',
       format('가게 "%s" 업종 변경: "%s" → "%s"', new.name,
              coalesce(old.category, '없음'), coalesce(new.category, '없음')),
       jsonb_build_object('category', old.category), jsonb_build_object('category', new.category),
       src, src, run_id, now());
  end if;

  if old.lot_address is distinct from new.lot_address then
    insert into data_change_events
      (entity_type, entity_id, store_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, confirmed_at)
    values
      ('store', new.id, new.id, 'store_lot_address_changed',
       format('가게 "%s" 지번 주소 변경: "%s" → "%s"', new.name,
              coalesce(old.lot_address, '없음'), coalesce(new.lot_address, '없음')),
       jsonb_build_object('lot_address', old.lot_address),
       jsonb_build_object('lot_address', new.lot_address), src, src, run_id, now());
  end if;

  if old.district is distinct from new.district then
    insert into data_change_events
      (entity_type, entity_id, store_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, confirmed_at)
    values
      ('store', new.id, new.id, 'store_district_changed',
       format('가게 "%s" 자치구 변경: "%s" → "%s"', new.name,
              coalesce(old.district, '없음'), coalesce(new.district, '없음')),
       jsonb_build_object('district', old.district), jsonb_build_object('district', new.district),
       src, src, run_id, now());
  end if;

  if old.lat is distinct from new.lat or old.lng is distinct from new.lng then
    insert into data_change_events
      (entity_type, entity_id, store_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, confirmed_at)
    values
      ('store', new.id, new.id, 'store_location_changed',
       format('가게 "%s" 위치 변경: (%s, %s) → (%s, %s)', new.name,
              old.lat, old.lng, new.lat, new.lng),
       jsonb_build_object('lat', old.lat, 'lng', old.lng),
       jsonb_build_object('lat', new.lat, 'lng', new.lng), src, src, run_id, now());
  end if;

  if old.license_no is distinct from new.license_no then
    insert into data_change_events
      (entity_type, entity_id, store_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, confirmed_at)
    values
      ('store', new.id, new.id, 'store_license_changed',
       format('가게 "%s" 관리번호 변경', new.name),
       jsonb_build_object('license_no', old.license_no),
       jsonb_build_object('license_no', new.license_no), src, src, run_id, now());
  end if;

  if old.source is distinct from new.source then
    insert into data_change_events
      (entity_type, entity_id, store_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, confirmed_at)
    values
      ('store', new.id, new.id, 'store_source_changed',
       format('가게 "%s" 출처 변경: "%s" → "%s"', new.name, old.source, new.source),
       jsonb_build_object('source', old.source), jsonb_build_object('source', new.source),
       src, src, run_id, now());
  end if;

  return new;
end;
$$;

drop trigger if exists audit_stores_change_trigger on stores;
create trigger audit_stores_change_trigger
after insert or update or delete on stores
for each row execute function audit_stores_change();

create or replace function audit_menus_change()
returns trigger
language plpgsql
as $$
declare
  src text;
  run_id uuid;
  verification uuid;
  candidate_id uuid;
begin
  src := coalesce(nullif(current_setting('app.change_source', true), ''),
                  case when tg_op = 'DELETE' then old.source else new.source end,
                  'database');
  run_id := audit_context_uuid('app.ingestion_run_id');
  verification := audit_context_uuid('app.verification_id');
  candidate_id := audit_context_uuid('app.change_candidate_id');

  if tg_op = 'INSERT' then
    insert into menu_price_history (menu_id, old_price, new_price, source, verification_id)
    values (new.id, null, new.price, src, verification)
    on conflict do nothing;

    insert into data_change_events
      (entity_type, entity_id, store_id, menu_id, event_type, summary, new_value,
       source, actor, ingest_run_id, verification_id, confirmed_at)
    values
      ('menu', new.id, new.store_id, new.id, 'menu_created',
       format('메뉴 "%s" 등록 (%s원)', new.name, to_char(new.price, 'FM999,999,999')),
       jsonb_build_object('name', new.name, 'price', new.price, 'is_available', new.is_available),
       src, src, run_id, verification, now());
    return new;
  end if;

  if tg_op = 'DELETE' then
    insert into data_change_events
      (entity_type, entity_id, store_id, menu_id, event_type, summary, old_value,
       source, actor, ingest_run_id, verification_id, confirmed_at)
    values
      ('menu', old.id, old.store_id, old.id, 'menu_deleted', format('메뉴 "%s" 삭제', old.name),
       jsonb_build_object('name', old.name, 'price', old.price, 'is_available', old.is_available),
       src, src, run_id, verification, now());
    return old;
  end if;

  -- 가격 전용 표는 기존 API와 호환을 위해 유지하되, 이제 모든 변경 경로가 자동으로 쓴다.
  if old.price is distinct from new.price then
    insert into menu_price_history (menu_id, old_price, new_price, source, verification_id)
    values (new.id, old.price, new.price, src, verification);
  end if;

  if candidate_id is not null then
    return new;
  end if;

  if old.price is distinct from new.price then
    insert into data_change_events
      (entity_type, entity_id, store_id, menu_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, verification_id, confirmed_at)
    values
      ('menu', new.id, new.store_id, new.id, 'menu_price_changed',
       format('메뉴 "%s" 가격 변경: %s원 → %s원', new.name,
              to_char(old.price, 'FM999,999,999'), to_char(new.price, 'FM999,999,999')),
       jsonb_build_object('price', old.price), jsonb_build_object('price', new.price),
       src, src, run_id, verification, now());
  end if;

  if old.is_available is distinct from new.is_available then
    insert into data_change_events
      (entity_type, entity_id, store_id, menu_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, verification_id, confirmed_at)
    values
      ('menu', new.id, new.store_id, new.id,
       case when new.is_available then 'menu_restored' else 'menu_removed' end,
       format('메뉴 "%s" %s', new.name,
              case when new.is_available then '판매 재개' else '판매 종료' end),
       jsonb_build_object('is_available', old.is_available),
       jsonb_build_object('is_available', new.is_available),
       src, src, run_id, verification, now());
  end if;

  if old.name is distinct from new.name then
    insert into data_change_events
      (entity_type, entity_id, store_id, menu_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, verification_id, confirmed_at)
    values
      ('menu', new.id, new.store_id, new.id, 'menu_renamed',
       format('메뉴 이름 변경: "%s" → "%s"', old.name, new.name),
       jsonb_build_object('name', old.name), jsonb_build_object('name', new.name),
       src, src, run_id, verification, now());
  end if;

  if old.store_id is distinct from new.store_id then
    insert into data_change_events
      (entity_type, entity_id, store_id, menu_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, verification_id, confirmed_at)
    values
      ('menu', new.id, new.store_id, new.id, 'menu_store_changed',
       format('메뉴 "%s" 소속 가게 변경', new.name),
       jsonb_build_object('store_id', old.store_id), jsonb_build_object('store_id', new.store_id),
       src, src, run_id, verification, now());
  end if;

  if old.sort_order is distinct from new.sort_order then
    insert into data_change_events
      (entity_type, entity_id, store_id, menu_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, verification_id, confirmed_at)
    values
      ('menu', new.id, new.store_id, new.id, 'menu_order_changed',
       format('메뉴 "%s" 노출 순서 변경: %s → %s', new.name, old.sort_order, new.sort_order),
       jsonb_build_object('sort_order', old.sort_order),
       jsonb_build_object('sort_order', new.sort_order), src, src, run_id, verification, now());
  end if;

  if old.image_url is distinct from new.image_url then
    insert into data_change_events
      (entity_type, entity_id, store_id, menu_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, verification_id, confirmed_at)
    values
      ('menu', new.id, new.store_id, new.id, 'menu_image_changed',
       format('메뉴 "%s" 사진 %s', new.name,
              case when new.image_url is null then '삭제'
                   when old.image_url is null then '등록' else '변경' end),
       jsonb_build_object('image_url', old.image_url),
       jsonb_build_object('image_url', new.image_url), src, src, run_id, verification, now());
  end if;

  if old.source is distinct from new.source then
    insert into data_change_events
      (entity_type, entity_id, store_id, menu_id, event_type, summary, old_value, new_value,
       source, actor, ingest_run_id, verification_id, confirmed_at)
    values
      ('menu', new.id, new.store_id, new.id, 'menu_source_changed',
       format('메뉴 "%s" 출처 변경: "%s" → "%s"', new.name, old.source, new.source),
       jsonb_build_object('source', old.source), jsonb_build_object('source', new.source),
       src, src, run_id, verification, now());
  end if;

  return new;
end;
$$;

drop trigger if exists audit_menus_change_trigger on menus;
create trigger audit_menus_change_trigger
after insert or update or delete on menus
for each row execute function audit_menus_change();

-- 앱은 직접 DB 연결 역할로 접근하고, 공개 PostgREST에는 정책을 두지 않아 deny-all.
alter table ingestion_runs     enable row level security;
alter table data_change_events enable row level security;
alter table point_transactions enable row level security;
alter table rate_limits        enable row level security;
do $$
begin
  if to_regclass('public.schema_migrations') is not null then
    execute 'alter table schema_migrations enable row level security';
  end if;
end;
$$;
