import type { NextRequest } from 'next/server'
import { sql } from './db'

// IP 기반 레이트리밋.
//
// 신원(userId)은 클라이언트가 만든 UUID라 회전 한 줄로 기기 단위 방어가 다 리셋된다.
// IP는 클라이언트가 못 바꾸는(Vercel이 세팅) 유일한 신호라, 회전 어뷰징·LLM 비용폭탄의
// 근본 방어를 여기 둔다. 고정 창(fixed-window) 카운터 — upsert 한 번으로 끝난다.
//
// 한계: 모바일 캐리어·회사 NAT는 IP를 공유하므로 한도는 넉넉히 잡는다. 진짜 고트래픽이
// 되면 Upstash/Vercel KV(인메모리)로 갈아탈 여지를 둔다. Postgres는 새 의존성 없이
// 지금 바로 되는 MVP 선택.

/**
 * 클라이언트 IP. Vercel이 세팅하는 x-real-ip를 우선한다 — 클라이언트가 못 바꾼다.
 * x-forwarded-for는 클라가 앞에 위조값을 붙일 수 있으므로 폴백으로만, 그것도 첫 항목.
 * (Vercel은 진짜 IP를 x-real-ip로 준다.) 로컬 등 헤더가 없으면 'unknown'.
 */
export function clientIp(req: NextRequest): string {
  const real = req.headers.get('x-real-ip')
  if (real) return real.trim()
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return 'unknown'
}

/**
 * 고정 창 레이트리밋. windowSec 창에서 (bucket, ip)의 요청 수를 세어 limit 이하면 통과.
 * @returns true = 통과(허용), false = 초과(429로 막아야 함)
 *
 * DB 오류 시 fail-open(통과)한다 — 레이트리밋 장애가 서비스를 죽이면 안 된다.
 */
export async function rateLimit(
  bucket: string,
  ip: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  try {
    const [row] = await sql<{ count: number }[]>`
      insert into rate_limits (bucket, ip, window_start, count)
      values (
        ${bucket}, ${ip},
        to_timestamp(floor(extract(epoch from now()) / ${windowSec}) * ${windowSec}),
        1
      )
      on conflict (bucket, ip, window_start)
        do update set count = rate_limits.count + 1
      returning count
    `
    return row.count <= limit
  } catch {
    return true // fail-open
  }
}
