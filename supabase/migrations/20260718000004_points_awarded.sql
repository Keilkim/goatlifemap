-- 포인트 지급 여부.
--
-- 정책과 무관하게 포인트는 "운영자가 확인한 뒤"에만 지급된다. 그러려면 "이미 줬나"를
-- 기록해야 한다 — 이중지급을 막고, optimistic 정책으로 지도에 바로 뜬(approved) 기여도
-- 운영자 확정 대기열(포인트 미지급)에 잡히게 하려면.
alter table menu_reviews
  add column if not exists points_awarded boolean not null default true;
alter table menu_verifications
  add column if not exists points_awarded boolean not null default true;

-- migrate-first 무중단 배포에서 구버전 서버는 이 컬럼을 빼고 INSERT하면서 포인트를
-- 즉시 준다. default=true여야 그 짧은 공존 구간의 기여가 나중에 이중 지급되지 않는다.
-- 신버전 API는 INSERT에서 false를 명시해 승인 후 지급 대기임을 구분한다.
alter table menu_reviews alter column points_awarded set default true;
alter table menu_verifications alter column points_awarded set default true;

-- 기존 앱은 상태와 관계없이 제보 제출 즉시 포인트를 줬다. 특히 가격변경·단종은
-- admin_ops에서 pending으로 남으므로 status 기준으로 나누면 승인 때 이중 지급된다.
-- 이 컬럼을 추가하는 시점에 이미 존재하는 기여는 모두 과거 지급분으로 기준선 처리한다.
update menu_reviews set points_awarded = true;
update menu_verifications set points_awarded = true;

-- "확정 대기" 조회용 — 미지급 기여를 빠르게 찾는다.
create index if not exists menu_reviews_unpaid_idx on menu_reviews (created_at) where not points_awarded;
