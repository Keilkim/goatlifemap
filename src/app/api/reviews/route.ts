import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { ensureUser, isValidUserId } from '@/lib/user'
import { moderateComment } from '@/lib/moderation'
import { initialStatus } from '@/lib/policy'
import { clientIp, rateLimit } from '@/lib/ratelimit'

// 메뉴 리뷰.
//
// 식당 리뷰가 아니라 메뉴 리뷰다. 이 서비스의 단위가 메뉴이기 때문이다 —
// "이 집 괜찮아요"보다 "이 김치찌개 양 많아요"가 점심을 고르는 데 쓸모 있다.

const ALLOWED_TAGS = new Set([
  'good_value', 'portion_big', 'tasty', 'fast', 'solo_ok', 'portion_small',
])

export async function GET(req: NextRequest) {
  const menuId = req.nextUrl.searchParams.get('menuId')
  if (!isValidUserId(menuId)) {
    return NextResponse.json({ error: 'invalid menuId' }, { status: 400 })
  }

  // 자동 감지에 걸린(pending) 리뷰는 지도에 노출하지 않는다. approved만 보인다.
  const reviews = await sql<
    { id: string; tags: string[]; comment: string | null; image_url: string | null; created_at: string }[]
  >`
    select id, tags, comment, image_url, created_at
    from menu_reviews
    where menu_id = ${menuId} and status = 'approved'
    order by created_at desc
    limit 20
  `

  // 태그별 개수 — "가성비 좋아요 12"처럼 남들 의견이 한눈에 보여야 한다.
  // 도배범의 태그가 개수를 부풀리지 않게 approved만 센다.
  const counts = await sql<{ tag: string; n: number }[]>`
    select unnest(tags) as tag, count(*)::int as n
    from menu_reviews
    where menu_id = ${menuId} and status = 'approved'
    group by 1
  `

  return NextResponse.json({
    reviews,
    tagCounts: Object.fromEntries(counts.map((c) => [c.tag, c.n])),
  })
}

export async function POST(req: NextRequest) {
  // IP 레이트리밋 — 일일제한은 UUID에 걸려 회전으로 뚫린다. IP로 대량 가짜리뷰를 막는다.
  if (!(await rateLimit('reviews', clientIp(req), 12, 60))) {
    return NextResponse.json({ error: '잠시 후 다시 시도해주세요' }, { status: 429 })
  }

  let body: { userId?: string; menuId?: string; tags?: string[]; comment?: string; rating?: number | null }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const { userId, menuId, tags, comment, rating } = body
  if (!isValidUserId(userId)) return NextResponse.json({ error: 'invalid userId' }, { status: 400 })
  if (!isValidUserId(menuId)) return NextResponse.json({ error: 'invalid menuId' }, { status: 400 })

  const clean = (tags ?? []).filter((t) => ALLOWED_TAGS.has(t))
  // 별점만 남겨도 되고 태그만 남겨도 된다. 둘 다 없으면 남길 게 없다.
  //
  // 3.7 같은 값을 반올림해서 받지 않는다. 별은 다섯 개고 사용자가 고를 수 있는 건
  // 정수뿐인데, 소수점이 들어왔다는 건 클라이언트가 우리가 모르는 짓을 했다는 뜻이다.
  // 조용히 4로 바꾸면 사용자가 매기지 않은 점수가 평균에 섞인다.
  const stars = rating ?? null
  if (stars !== null && (!Number.isInteger(stars) || stars < 1 || stars > 5)) {
    return NextResponse.json({ error: '별점은 1~5 정수입니다' }, { status: 400 })
  }
  if (!clean.length && stars === null) {
    return NextResponse.json({ error: '별점이나 태그를 하나 이상 남겨주세요' }, { status: 400 })
  }

  const text = comment?.trim() || null
  if (text && text.length > 200) {
    return NextResponse.json({ error: '한 줄까지만 써주세요' }, { status: 400 })
  }

  const { blocked } = await ensureUser(userId)
  if (blocked) return NextResponse.json({ error: '차단된 기기입니다' }, { status: 403 })

  // 검열에 걸린 건 정책과 무관하게 항상 보류(pending). 통과한 건 정책에 따라
  // (기본 optimistic=즉시 노출 / gated=승인 대기). 포인트는 어느 쪽이든 제출 즉시가
  // 아니라 운영자가 확인한 뒤에만 지급된다 — 여기선 항상 0.
  // 코멘트가 있으면 채팅과 마찬가지로 규칙 통과분도 가벼운 AI가 전부 본다.
  // 별점/선택 태그만 남긴 경우에는 검사할 자유 텍스트가 없어 호출하지 않는다.
  const verdict = await moderateComment(userId, text, 'review', { aiAlways: true })
  const flagged = verdict.action === 'flag'
  const status = flagged ? 'pending' : initialStatus()

  try {
    const result = await sql.begin(async (tx) => {
      const [review] = await tx<
        { id: string; tags: string[]; comment: string | null; image_url: string | null; created_at: string }[]
      >`
        insert into menu_reviews
          (menu_id, user_id, tags, comment, rating, status, flagged_reason, points_awarded)
        values
          (${menuId}, ${userId}, ${clean}, ${text}, ${stars}, ${status}, ${verdict.reason}, false)
        returning id, tags, comment, image_url, created_at, rating
      `
      // 검열에 걸린 기기는 flag_count를 올려 운영자 대기열에서 눈에 띄게 한다.
      if (flagged) {
        await tx`update app_users set flag_count = flag_count + 1 where id = ${userId}`
      }
      const [u] = await tx<{ points: number }[]>`select points from app_users where id = ${userId}`
      return { review, points: u.points }
    })
    return NextResponse.json({ ok: true, ...result, earned: 0, status })
  } catch (e) {
    // DB의 하루 1회 unique 인덱스에 걸린 경우
    if (e instanceof Error && 'code' in e && e.code === '23505') {
      return NextResponse.json({ error: '오늘 이미 이 메뉴에 남겼어요' }, { status: 409 })
    }
    if (e instanceof Error && 'code' in e && e.code === '23503') {
      return NextResponse.json({ error: '없는 메뉴입니다' }, { status: 404 })
    }
    throw e
  }
}
