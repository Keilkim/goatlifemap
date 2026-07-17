-- 점심방어 초기 스키마
-- 로컬 Postgres 17과 Supabase 양쪽에서 동일하게 동작하도록 작성.
-- PostGIS를 쓰지 않는 이유: bbox 조회는 lat/lng btree 범위검색으로 충분하고,
-- 확장 의존이 없어야 로컬과 Supabase가 완전히 같은 SQL로 돈다.

create extension if not exists pgcrypto;

-- 가게. 뼈대는 서울시 일반음식점 인허가 공공데이터(공공누리 1유형)에서 적재한다.
create table if not exists stores (
  id           uuid primary key default gen_random_uuid(),
  -- 공공데이터의 관리번호. 재적재 시 upsert 키로 쓴다.
  license_no   text unique,
  name         text not null,
  road_address text,
  lot_address  text,
  -- 공공데이터 업태구분명 (한식/중식/일식/분식 등) 원문
  category     text,
  lat          double precision not null,
  lng          double precision not null,
  -- 영업/폐업. 공공데이터의 상세영업상태명
  is_open      boolean not null default true,
  -- 'seoul_opendata' | 'manual'
  source       text not null default 'seoul_opendata',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 지도 bbox 조회용. lat 범위로 좁힌 뒤 lng를 거른다.
create index if not exists stores_lat_lng_idx on stores (lat, lng);
-- "메뉴가 있는 가게만" 이 기본 노출이므로 부분 인덱스가 효율적이다.
create index if not exists stores_open_idx on stores (is_open) where is_open;

-- 메뉴. 이 서비스의 진짜 자산. 공공데이터에 없으므로 사람이 채운다.
create table if not exists menus (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references stores(id) on delete cascade,
  name          text not null,
  price         integer not null check (price >= 0),
  -- 가게당 대표 메뉴 노출 순서 (0이 대표)
  sort_order    integer not null default 0,
  is_available  boolean not null default true,
  -- 신뢰도의 근거: 마지막으로 가격이 확인된 시점
  verified_at   timestamptz not null default now(),
  -- 'manual' | 'official_menu' | 'user_report'
  source        text not null default 'manual',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (store_id, name)
);

create index if not exists menus_store_idx on menus (store_id);
create index if not exists menus_price_idx on menus (price) where is_available;

-- 사용자. 로컬에서는 익명 device UUID를 그대로 id로 쓴다.
-- Supabase 이관 시 이 테이블은 auth.users를 참조하는 profiles로 바뀌고,
-- 아래 모든 user_id는 auth.uid()가 채운다. 컬럼 구조는 그대로 유지된다.
create table if not exists app_users (
  id          uuid primary key default gen_random_uuid(),
  -- 밥온도. 정확한 제보로 오르고 허위 제보로 내려간다.
  points      integer not null default 0,
  is_anonymous boolean not null default true,
  created_at  timestamptz not null default now()
);

-- 메뉴 검증 제보. 포인트의 원천이자 신뢰도의 근거.
create table if not exists menu_verifications (
  id            uuid primary key default gen_random_uuid(),
  menu_id       uuid not null references menus(id) on delete cascade,
  user_id       uuid not null references app_users(id) on delete cascade,
  -- 'price_ok' | 'price_changed' | 'sold_out' | 'still_selling'
  kind          text not null check (kind in ('price_ok','price_changed','sold_out','still_selling')),
  -- price_changed일 때만 채워진다
  reported_price integer check (reported_price >= 0),
  created_at    timestamptz not null default now(),
  -- 하루 1회 제한용. timestamptz::date 캐스트는 TimeZone 의존이라 IMMUTABLE이 아니어서
  -- 인덱스 표현식에 못 쓴다. 한국 날짜를 컬럼으로 고정해 unique 인덱스를 건다.
  created_on    date not null default (now() at time zone 'Asia/Seoul')::date
);

create index if not exists menu_verifications_menu_idx on menu_verifications (menu_id, created_at desc);

-- 어뷰징 방지: 같은 사용자가 같은 메뉴를 하루에 한 번만 검증할 수 있다.
-- DB 레벨에서 막아야 클라이언트를 우회해도 뚫리지 않는다.
create unique index if not exists menu_verifications_daily_unique
  on menu_verifications (menu_id, user_id, created_on);

-- A/B 실험 배정. device_id 기준으로 고정되어 재방문 시에도 같은 그룹을 유지한다.
create table if not exists ab_assignments (
  user_id     uuid not null references app_users(id) on delete cascade,
  experiment  text not null,
  variant     text not null,
  assigned_at timestamptz not null default now(),
  primary key (user_id, experiment)
);

-- 행동 로그. 토글 니즈 검증의 핵심 데이터.
create table if not exists events (
  id         bigserial primary key,
  user_id    uuid references app_users(id) on delete set null,
  session_id uuid,
  name       text not null,
  props      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists events_name_created_idx on events (name, created_at desc);
create index if not exists events_user_idx on events (user_id, created_at);
