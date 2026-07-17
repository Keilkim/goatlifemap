-- 착한가격업소 적재를 위한 준비.
--
-- 착한가격업소(행정안전부)는 우리가 없던 것 — 메뉴명과 가격 — 을 가진 유일한 공공데이터다.
-- 서울 외식업 1,452곳, 그중 만원 이하가 1,135곳(81%), 중앙값 7,000원.
-- 정의상 전부 저가 업소라 "만원 이하 점심"이라는 목적에 적중률이 높다.
--
-- 왜 인허가 데이터와 매칭하지 않는가:
--   이름+좌표 100m로 대조해보니 6%만 매칭됐다. 우리가 적재한 건 일반음식점이고
--   착한가격업소에는 휴게음식점(분식/카페)이 섞여 있어서다. 억지로 매칭하면 오히려
--   엉뚱한 가게에 메뉴를 붙이게 된다.
--   대신 별도 가게로 넣는다. 지도는 "메뉴 있는 가게"만 띄우므로 같은 식당의 인허가
--   레코드는 메뉴가 없어 표시되지 않는다 — 중복 마커가 생기지 않는다.

-- 착한가격업소는 분기 갱신이고 정부가 가격을 검증한다.
-- 이 사실 자체가 신뢰도의 근거이므로 출처를 구분해 둔다.
comment on column stores.source is
  '데이터 출처: seoul_opendata(서울시 인허가) | goodprice(행안부 착한가격업소) | manual | demo';
comment on column menus.source is
  '메뉴 출처: official_menu(착한가격업소 등 공식) | manual(사람이 확인해 입력) | user_report | demo';

-- 착한가격업소는 업소당 메뉴가 최대 4개다. 같은 업소가 여러 행으로 오므로
-- (store_id, name) unique로 자연스럽게 정리된다 — 이미 걸려 있다.

-- 가게 이름 검색용. 관리자 페이지가 96,000곳에서 이름으로 찾는다.
create extension if not exists pg_trgm;
create index if not exists stores_name_trgm_idx on stores using gin (name gin_trgm_ops);
