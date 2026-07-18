-- IP 기반 레이트리밋(고정 창 카운터).
--
-- 신원이 클라이언트가 만든 UUID라 기기 단위 방어는 UUID 회전 한 줄로 리셋된다. IP는
-- 클라이언트가 못 바꾸는(Vercel이 세팅하는 x-real-ip) 유일한 신호라, 회전 어뷰징·LLM
-- 비용폭탄의 근본 방어를 여기 둔다.
--
-- 고정 창: window_start를 windowSec 단위로 내림해서 (bucket, ip, window_start)로 센다.
-- 창이 넘어가면 새 행이라 카운트가 리셋된다. 슬라이딩보다 단순하고 upsert 한 번이면 된다.
create table if not exists rate_limits (
  bucket       text        not null,
  ip           text        not null,
  window_start timestamptz not null,
  count        int         not null default 0,
  primary key (bucket, ip, window_start)
);

-- 오래된 창 행 정리(GC)용. DEPLOY.md의 주기 삭제가 이 인덱스를 탄다.
create index if not exists rate_limits_gc_idx on rate_limits (window_start);
