-- 메뉴 별점.
--
-- 식당 별점이 아니라 메뉴 별점이다. 같은 집이라도 김치찌개는 훌륭하고 돈까스는
-- 별로일 수 있는데, 식당 하나로 뭉뚱그리면 그 차이가 사라진다.
-- 이 서비스의 단위가 메뉴인 이유와 같다.

alter table menu_reviews add column if not exists rating smallint
  check (rating is null or rating between 1 and 5);

create index if not exists menu_reviews_rating_idx on menu_reviews (menu_id) where rating is not null;
