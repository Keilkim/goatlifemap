-- 데이터 운영: 가격 이력 + 제보 승인 흐름.
--
-- 그동안은 스크립트로 직접 UPDATE했고, 사용자 제보는 menu_verifications에 쌓이기만
-- 하고 지도엔 반영되지 않았다. 이제 제대로 된 흐름을 만든다:
--   사용자가 제보 → 쌓임 → 운영자가 /admin에서 승인 → 지도 반영 + 이력 기록
-- 허위·장난 제보가 바로 들이치지 않게 하려면 승인 단계가 있어야 한다.

-- 가격 변경 이력.
--
-- menu.price는 "지금 얼마"라는 현재값 하나다. 하지만 "언제부터 얼마였다"를 알아야
-- "3개월 전 7,000 → 8,000"을 보여줄 수 있고, 가격이 자주 바뀌는 집인지(노후화 위험)도
-- 판단할 수 있다. 그래서 변경이 확정될 때마다 여기 한 줄을 남긴다.
create table if not exists menu_price_history (
  id          uuid primary key default gen_random_uuid(),
  menu_id     uuid not null references menus(id) on delete cascade,
  old_price   integer,                    -- 최초 기록이면 null
  new_price   integer not null check (new_price >= 0),
  -- 'ingest'(공공데이터 최초) | 'admin'(운영자 직접) | 'report'(사용자 제보 승인)
  source      text not null,
  -- report에서 왔으면 어느 제보를 승인한 건지
  verification_id uuid references menu_verifications(id) on delete set null,
  changed_at  timestamptz not null default now()
);

create index if not exists price_history_menu_idx on menu_price_history (menu_id, changed_at desc);

-- 제보 처리 상태.
--
-- 지금까지 제보는 쌓이기만 하고 처리 여부를 몰랐다. 상태를 붙여
-- "아직 안 본 제보 / 승인 / 반려"를 구분한다. 운영자 대기열의 근거가 된다.
alter table menu_verifications
  add column if not exists status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected'));

-- 제보 종류를 바꾼다. sold_out(오늘 품절)은 점심 지도에 안 맞다 — 하루 품절을
-- 신고받아봐야 내일이면 다시 파는데 되돌릴 방법이 없다. 진짜 필요한 건
-- discontinued(메뉴가 아예 없어짐)다. 이건 승인하면 메뉴를 내린다.
alter table menu_verifications drop constraint if exists menu_verifications_kind_check;
update menu_verifications set kind = 'discontinued' where kind = 'sold_out';
alter table menu_verifications add constraint menu_verifications_kind_check
  -- 무중단 전환 중 잠시 살아 있는 구버전 API의 sold_out도 받는다. 새 앱은
  -- discontinued만 쓰며, sold_out은 관리자 승인에서 같은 내림 동작으로 처리한다.
  check (kind in ('price_ok', 'price_changed', 'discontinued', 'still_selling', 'sold_out'));

-- price_ok(가격 맞음)·still_selling은 승인할 것이 없다 — 확인일만 갱신하면 끝이라
-- 처음부터 approved로 둔다. 대기열엔 실제로 뭔가 바꿔야 하는 것만 남는다.
update menu_verifications set status = 'approved'
  where kind in ('price_ok', 'still_selling') and status = 'pending';

create index if not exists verifications_pending_idx
  on menu_verifications (created_at) where status = 'pending';

-- 지금 menu에 있는 가격을 이력의 출발점으로 한 줄씩 심는다.
-- 이게 없으면 "원래 얼마였다"의 기준이 없어 첫 변경 때 old_price가 늘 null이 된다.
insert into menu_price_history (menu_id, old_price, new_price, source, changed_at)
select m.id, null, m.price, 'ingest', m.created_at
from menus m
where not exists (
  select 1 from menu_price_history h
  where h.menu_id = m.id and h.old_price is null
);
