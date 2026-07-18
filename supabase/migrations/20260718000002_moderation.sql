-- 어뷰징 방어: 기기 차단 + 자동 감지.
--
-- 정직하게 말하면 device UUID는 완벽한 신원이 아니다. localStorage를 지우면 새로
-- 생기고 시크릿 창이면 매번 다르다. 그래서 이 차단은 "약한 방어"다 — 작정한 어뷰저는
-- 우회한다. 하지만 장난 도배의 대부분은 여기서 막힌다. 완전한 제재는 Supabase Auth로
-- 옮겨 진짜 계정에 묶은 뒤에나 가능하다.

-- 기기(사용자) 상태.
alter table app_users
  -- 운영자가 차단한 기기. 차단되면 이후 제보·리뷰가 전부 거부된다.
  add column if not exists blocked_at timestamptz,
  -- 자동 감지에 걸린 횟수. 쌓이면 운영자 대기열에서 눈에 띈다.
  add column if not exists flag_count integer not null default 0;

create index if not exists app_users_blocked_idx on app_users (blocked_at) where blocked_at is not null;

-- 리뷰 처리 상태. 자동 감지에 걸리면 pending(보류)으로 두고 운영자가 본다.
-- 통과하면 approved. 지도/리뷰 목록엔 approved만 보인다.
alter table menu_reviews
  add column if not exists status text not null default 'approved'
    check (status in ('pending', 'approved', 'rejected')),
  -- 왜 걸렸는지 (link|phone|dup|profanity|ai). 운영자가 판단할 근거.
  add column if not exists flagged_reason text;

create index if not exists menu_reviews_pending_idx on menu_reviews (created_at) where status = 'pending';

-- 자동 감지 로그. "같은 문구 복붙"을 잡으려면 최근 제출 텍스트를 봐야 한다.
-- comment_norm은 정규화한(공백·기호 제거) 텍스트라, 살짝 바꿔 도배해도 같은 값이 된다.
create table if not exists moderation_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references app_users(id) on delete cascade,
  target_kind  text not null,        -- 'review' | 'verification'
  comment_norm text,
  reason       text,                 -- 걸린 이유. 통과면 null
  created_at   timestamptz not null default now()
);

create index if not exists moderation_norm_idx on moderation_log (comment_norm, created_at desc);
create index if not exists moderation_user_idx on moderation_log (user_id, created_at desc);
