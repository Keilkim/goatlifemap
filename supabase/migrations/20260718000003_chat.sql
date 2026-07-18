-- 익명 실시간 채팅.
--
-- 가입이 없다. device UUID가 곧 신원이라 슈퍼베이스 Auth는 쓰지 않는다.
-- 닉네임은 UUID에서 결정적으로 뽑아낸다("배고픈 너구리") — 익명이되 구분은 된다.
--
-- 방(room)은 지금 'global' 하나뿐이다. 사람이 많아지면 감당이 안 되므로, 그때
-- 지도에 보이는 지역 키(예: 격자·행정동)를 room에 넣어 방을 쪼갠다. 스키마는
-- 그날을 위해 room 컬럼을 미리 둔다 — 나중에 데이터만 바꾸면 되지 마이그레이션이
-- 다시 필요하지 않게.
create table if not exists chat_messages (
  id         uuid primary key default gen_random_uuid(),
  room       text not null default 'global',
  -- 기기가 지워지거나 차단돼도 지난 대화는 남는다(작성자만 끊어짐).
  user_id    uuid references app_users(id) on delete set null,
  body       text not null,
  created_at timestamptz not null default now()
);

-- "이 방의 최근 대화" + "이 시각 이후 새 메시지"(폴링) 둘 다 이 인덱스로 커버된다.
create index if not exists chat_room_time_idx on chat_messages (room, created_at desc);
-- 도배 속도 제한: "이 기기가 최근 10초에 몇 개 보냈나"를 빠르게 세려고.
create index if not exists chat_user_time_idx on chat_messages (user_id, created_at desc);
