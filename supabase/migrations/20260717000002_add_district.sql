-- 자치구 컬럼.
-- "데이터는 밀집지역부터" 전략을 쓰므로, 구별로 얼마나 채워졌는지 볼 수 있어야 한다.
-- 주소 문자열을 매번 파싱하는 대신 적재 시점에 넣는다.

alter table stores add column if not exists district text;

create index if not exists stores_district_idx on stores (district);
