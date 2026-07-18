import { NextRequest, NextResponse } from 'next/server'
import postgres from 'postgres'
import { sql } from '@/lib/db'
import { ensureUser, isValidUserId } from '@/lib/user'
import { clientIp, rateLimit } from '@/lib/ratelimit'

// 행동 로그 수집.
// 토글 클릭 수만으로는 니즈를 알 수 없다. 각 보기에서 길찾기/상세까지
// 이어지는 전환율을 봐야 하므로 이벤트를 넓게 받는다.
const ALLOWED = new Set([
  'view_init',        // 최초 진입 (A/B 그룹, 어느 보기로 시작했는지)
  'toggle_switch',    // 보기 전환 (from, to, 직전 보기 체류시간)
  'view_dwell',       // 보기별 체류시간 누적
  'marker_click',
  'store_card_click',
  'menu_card_click',
  'directions_click', // 길찾기 — 실제 방문 의도의 가장 강한 신호
  'bookmark_click',
  'filter_change',
  'map_research',     // "이 지역에서 다시 찾기"
  'verify_click',
])

export async function POST(req: NextRequest) {
  // IP 레이트리밋 — 익명 이벤트도 UUID 회전으로 무제한 삽입돼 A/B 데이터를 오염시킨다.
  if (!(await rateLimit('events', clientIp(req), 60, 60))) {
    return NextResponse.json({ error: '잠시 후 다시 시도해주세요' }, { status: 429 })
  }

  let body: { userId?: string; sessionId?: string; events?: { name: string; props?: unknown }[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const { userId, sessionId, events } = body
  if (!isValidUserId(userId)) return NextResponse.json({ error: 'invalid userId' }, { status: 400 })
  if (!Array.isArray(events) || events.length === 0) return NextResponse.json({ ok: true, saved: 0 })
  // sendBeacon으로 한 번에 몰아 보내므로 배치 상한을 둔다
  if (events.length > 50) return NextResponse.json({ error: 'too many events' }, { status: 400 })

  // 차단된 기기는 로그도 못 남긴다(오염 방지). 예전엔 blocked를 무시했다.
  const { blocked } = await ensureUser(userId)
  if (blocked) return NextResponse.json({ error: '차단된 기기입니다' }, { status: 403 })

  const rows = events
    // 허용된 이벤트 + props 직렬화 크기 상한(2KB) — 검증 없는 jsonb 폭탄 방지.
    .filter((e) => ALLOWED.has(e.name) && JSON.stringify(e.props ?? {}).length <= 2000)
    .map((e) => ({
      user_id: userId,
      session_id: isValidUserId(sessionId) ? sessionId : null,
      name: e.name,
      // jsonb 컬럼에 넣으려면 postgres가 객체를 배열/행으로 오해하지 않도록 명시해야 한다
      props: sql.json((e.props ?? {}) as postgres.JSONValue),
    }))

  if (rows.length) {
    await sql`insert into events ${sql(rows, 'user_id', 'session_id', 'name', 'props')}`
  }
  return NextResponse.json({ ok: true, saved: rows.length })
}
