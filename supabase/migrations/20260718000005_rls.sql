-- Supabase 하드닝: 모든 앱 테이블에 RLS(행 수준 보안)를 켠다.
--
-- 이 앱은 Supabase 클라이언트(anon key)를 쓰지 않는다 — 모든 접근은 서버 API 라우트가
-- DATABASE_URL(postgres 역할)로 직접 SQL을 날린다. 그 역할은 RLS를 우회하므로 앱 동작엔
-- 아무 영향이 없다.
--
-- 그런데 Supabase는 기본으로 PostgREST(anon key로 접근하는 REST)를 노출한다. RLS가 꺼져
-- 있으면 anon key가 어디선가 새는 순간 아무나 이 테이블들을 읽고 쓸 수 있다. 정책을 하나도
-- 두지 않고 RLS만 켜면(=deny-all) PostgREST 경로는 전부 막히고, 우리 직접 연결만 통한다.
-- 이중 안전장치다 — 우리는 애초에 PostgREST를 안 쓰지만, 켜 두면 실수로도 안 새게 된다.
--
-- enable은 멱등이라(이미 켜져 있어도 no-op) 다시 돌려도 안전하다. 로컬 Postgres에서도
-- 문법은 유효하다(그냥 켜질 뿐, 우리 로컬 접근도 postgres 역할이라 우회한다).
alter table app_users          enable row level security;
alter table stores             enable row level security;
alter table menus              enable row level security;
alter table menu_reviews       enable row level security;
alter table menu_verifications enable row level security;
alter table menu_price_history enable row level security;
alter table moderation_log     enable row level security;
alter table chat_messages      enable row level security;
alter table ab_assignments     enable row level security;
alter table events             enable row level security;
