-- 메뉴 리뷰.
--
-- 식당 리뷰가 아니라 메뉴 리뷰다. 이 서비스의 단위가 메뉴이기 때문이다 —
-- "이 집 괜찮아요"보다 "이 김치찌개 양 많아요"가 점심을 고르는 데 쓸모 있다.
--
-- 장문을 쓰게 하지 않는다. 사업계획서대로 선택형이 중심이다:
-- 빨리 참여할 수 있어야 정보가 쌓이고, 쌓여야 이 서비스가 산다.

create table if not exists menu_reviews (
  id         uuid primary key default gen_random_uuid(),
  menu_id    uuid not null references menus(id) on delete cascade,
  user_id    uuid not null references app_users(id) on delete cascade,
  -- 선택형 태그. 여러 개 고를 수 있다.
  -- 'portion_big'(양 많아요) | 'good_value'(가성비 좋아요) | 'tasty'(맛있어요)
  -- | 'fast'(빨리 나와요) | 'solo_ok'(혼밥 가능) | 'portion_small'(양 적어요)
  tags       text[] not null default '{}',
  -- 한 줄까지만. 없어도 된다.
  comment    text check (comment is null or length(comment) <= 200),
  image_url  text,
  created_at timestamptz not null default now(),
  created_on date not null default (now() at time zone 'Asia/Seoul')::date
);

create index if not exists menu_reviews_menu_idx on menu_reviews (menu_id, created_at desc);

-- 어뷰징 방지: 같은 사용자가 같은 메뉴에 하루 한 번만.
-- menu_verifications와 같은 이유로 DB에서 강제한다 — 라우트를 우회해도 뚫리지 않는다.
create unique index if not exists menu_reviews_daily_unique
  on menu_reviews (menu_id, user_id, created_on);
