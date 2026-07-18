import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { ensureUser, isValidUserId } from '@/lib/user'
import { moderateComment } from '@/lib/moderation'
import { nickname } from '@/lib/nickname'
import { clientIp, rateLimit } from '@/lib/ratelimit'

// 익명 실시간 채팅.
//
// 지금 방은 'global' 하나. 실시간은 슈퍼베이스 Realtime이 없는 로컬에서도 돌아야 하므로
// 폴링으로 간다(클라가 몇 초마다 since 이후만 가져감). 배포 뒤 Supabase에선 Realtime으로
// 갈아탈 수 있지만, 폴링만으로도 이 규모엔 충분하다.
//
// 방어는 리뷰와 같은 파이프라인을 쓰되 "flag = 즉시 차단"으로 해석한다(대기열이 아니라).
// 링크는 무조건 규칙에서 막히고, 욕설·음란·광고는 규칙+초저가 LLM이 본다. 채팅은 방어가
// 중요하므로 규칙을 통과한 메시지도 전부 LLM에 물어본다(aiAlways).

const ROOM = 'global' // 나중에 지역 키로 확장. 지금은 요청 room을 무시하고 전부 global.
const CHAT_KEEP = 100 // 글로벌 방이라 안 지우면 무한히 쌓인다 — 최신 이만큼만 남긴다.

type Row = { id: string; user_id: string | null; body: string; created_at: string }

function shape(rows: Row[], me: string) {
  return rows.map((r) => ({
    id: r.id,
    nick: r.user_id ? nickname(r.user_id) : '익명',
    body: r.body,
    created_at: r.created_at,
    mine: r.user_id === me, // user_id 자체는 노출하지 않는다(사칭 방지). 내 것만 표시.
  }))
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId')
  if (!isValidUserId(userId)) return NextResponse.json({ error: 'invalid userId' }, { status: 400 })
  // since가 유효한 타임스탬프일 때만 쓴다 — 아니면 created_at > ${since} 캐스트 에러(500)가 난다.
  const sinceParam = req.nextUrl.searchParams.get('since')
  const since = sinceParam && !Number.isNaN(Date.parse(sinceParam)) ? sinceParam : null

  // since가 있으면 폴링(그 시각 이후만), 없으면 첫 로드(최근 50개).
  const rows = since
    ? await sql<Row[]>`
        select id, user_id, body, created_at from chat_messages
        where room = ${ROOM} and created_at > ${since}
        order by created_at asc limit 100
      `
    : (
        await sql<Row[]>`
          select id, user_id, body, created_at from chat_messages
          where room = ${ROOM}
          order by created_at desc limit 50
        `
      ).reverse() // 최근 50개를 오래된→최신 순으로 뒤집어 화면에 그대로 쌓이게

  return NextResponse.json({ messages: shape(rows, userId) })
}

const MAX_LEN = 300
const RATE_MAX = 5 // 10초에 5개 초과면 도배로 본다

export async function POST(req: NextRequest) {
  // IP 레이트리밋 — 기존 UUID 5/10s는 회전으로 뚫리므로 IP로도 막는다(LLM 비용폭탄 방지).
  if (!(await rateLimit('chat-ip', clientIp(req), 20, 60))) {
    return NextResponse.json({ error: '잠시 후 다시 시도해주세요' }, { status: 429 })
  }

  let payload: { userId?: string; body?: string }
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const { userId } = payload
  if (!isValidUserId(userId)) return NextResponse.json({ error: 'invalid userId' }, { status: 400 })
  const body = payload.body?.trim()
  if (!body) return NextResponse.json({ error: '빈 메시지예요' }, { status: 400 })
  if (body.length > MAX_LEN) return NextResponse.json({ error: '메시지가 너무 길어요' }, { status: 400 })

  const { blocked } = await ensureUser(userId)
  if (blocked) return NextResponse.json({ error: '차단된 기기입니다' }, { status: 403 })

  // 속도 제한 — 실시간 채팅의 도배는 하루 1회 제한으로 못 막으므로 최근 N초를 센다.
  //
  // chat_messages가 아니라 moderation_log를 센다: 검열에 막힌(안 올라간) 시도도 세야
  // 한다. 안 그러면 매번 걸리는 문구만 던지는 공격자가 rate에 안 걸리고 LLM 호출·로그를
  // 무제한 발생시킨다(비용 폭탄). moderation_log는 채팅 시도마다 한 줄씩 남으므로,
  // 이 검사(검열 전)는 직전까지의 시도 수를 정확히 센다.
  const [recent] = await sql<{ n: number }[]>`
    select count(*)::int as n from moderation_log
    where user_id = ${userId} and target_kind = 'chat'
      and created_at > now() - interval '10 seconds'
  `
  if (recent.n >= RATE_MAX) {
    return NextResponse.json({ error: '잠깐, 조금 천천히요' }, { status: 429 })
  }

  // 방어: flag면 아예 안 올린다(대기열 없음). 링크·연락처는 규칙에서, 나머지는 규칙+LLM.
  const verdict = await moderateComment(userId, body, 'chat', { aiAlways: true })
  if (verdict.action === 'flag') {
    const msg: Record<string, string> = {
      link: '링크는 보낼 수 없어요',
      phone: '연락처는 보낼 수 없어요',
      profanity: '부적절한 표현이에요',
      dup: '같은 말을 너무 많이 보냈어요',
      ai: '부적절한 내용이에요',
    }
    // 걸린 기기는 flag_count를 올려 운영자 대기열에서 눈에 띄게 한다.
    await sql`update app_users set flag_count = flag_count + 1 where id = ${userId}`
    return NextResponse.json({ error: msg[verdict.reason ?? 'ai'] ?? '보낼 수 없는 메시지예요', reason: verdict.reason }, { status: 400 })
  }

  const [row] = await sql<Row[]>`
    insert into chat_messages (room, user_id, body)
    values (${ROOM}, ${userId}, ${body})
    returning id, user_id, body, created_at
  `

  // 최신 100개만 남기고 오래된 건 지운다. (room, created_at) 인덱스를 탄다.
  await sql`
    delete from chat_messages
    where room = ${ROOM} and id not in (
      select id from chat_messages where room = ${ROOM}
      order by created_at desc limit ${CHAT_KEEP}
    )
  `

  return NextResponse.json({ message: shape([row], userId)[0] })
}
