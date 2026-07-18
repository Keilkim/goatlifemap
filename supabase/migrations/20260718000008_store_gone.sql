-- 가게 폐업 제보(store_gone) 종류 추가.
--
-- 사용자가 메뉴 화면에서 "가게가 없어요"로 제보하면 menu_verifications에 kind='store_gone'으로
-- pending 적재된다. 운영자가 /admin에서 승인하면 그 메뉴가 속한 stores.is_open=false로 내린다
-- (지도 /api/stores는 is_open인 가게만 노출하므로 지도에서 사라진다. 삭제가 아니라 숨김이라
-- 오판이면 되돌릴 수 있고, audit 트리거가 store_closed 이벤트를 남긴다).
--
-- 기존 kind CHECK에 'store_gone'을 추가한다. (이전 값들은 legacy 데이터 때문에 유지)

alter table menu_verifications drop constraint if exists menu_verifications_kind_check;
alter table menu_verifications add constraint menu_verifications_kind_check
  check (kind in ('price_ok', 'price_changed', 'discontinued', 'still_selling', 'sold_out', 'store_gone'));
