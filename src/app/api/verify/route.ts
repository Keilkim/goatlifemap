import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { ensureUser, isValidUserId } from '@/lib/user'
import { clientIp, rateLimit } from '@/lib/ratelimit'

// 메뉴 검증 제보 + 포인트 적립.
//
// 제보가 지도에 바로 반영되지는 않는다. 허위·장난 제보가 그대로 들이치면 안 되므로,
// 가격 변경·단종뿐 아니라 "가격 맞아요"도 pending으로 쌓이고 운영자가 /admin에서
// 최종 확인해야 반영·지급된다. 제출만으로 verified_at과 포인트를 올리면 UUID를 바꿔
// 신뢰도와 포인트를 동시에 부풀릴 수 있기 때문이다.
//
// 포인트는 클라이언트가 보내는 값을 절대 믿지 않고 서버가 정한 표에 따라서만 준다.
// 하루 1회 제한은 DB의 unique 인덱스(menu_verifications_daily_unique)가 강제하므로
// 이 라우트를 우회해도 뚫리지 않는다.
const POINTS: Record<string, number> = {
  price_ok: 5,
  still_selling: 5,
  discontinued: 20,
  price_changed: 20,
}

export async function POST(req: NextRequest) {
  if (!(await rateLimit('verify', clientIp(req), 12, 60))) {
    return NextResponse.json({ error: '잠시 후 다시 시도해주세요' }, { status: 429 })
  }

  let body: { userId?: string; menuId?: string; kind?: string; reportedPrice?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const { userId, menuId, kind, reportedPrice } = body
  if (!isValidUserId(userId)) return NextResponse.json({ error: 'invalid userId' }, { status: 400 })
  if (!isValidUserId(menuId)) return NextResponse.json({ error: 'invalid menuId' }, { status: 400 })
  if (!kind || !(kind in POINTS)) return NextResponse.json({ error: 'invalid kind' }, { status: 400 })

  if (kind === 'price_changed') {
    if (!Number.isInteger(reportedPrice) || reportedPrice! < 0 || reportedPrice! > 1_000_000) {
      return NextResponse.json({ error: '변경된 가격을 정확히 입력해주세요' }, { status: 400 })
    }
  }

  const { blocked } = await ensureUser(userId)
  if (blocked) return NextResponse.json({ error: '차단된 기기입니다' }, { status: 403 })

  const status = 'pending' as const

  try {
    const result = await sql.begin(async (tx) => {
      const [inserted] = await tx<{ id: string }[]>`
        insert into menu_verifications
          (menu_id, user_id, kind, reported_price, status, points_awarded)
        values
          (${menuId}, ${userId}, ${kind}, ${kind === 'price_changed' ? reportedPrice! : null},
           ${status}, false)
        returning id
      `

      // 포인트는 제출 즉시 주지 않는다 — 운영자가 확인한 뒤 지급된다(reports 승인 시).
      // 여기선 현재 포인트만 돌려줘 헤더 표시가 흐트러지지 않게 한다.
      const [user] = await tx<{ points: number }[]>`select points from app_users where id = ${userId}`
      return { id: inserted.id, points: user.points, earned: 0, status }
    })

    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    // DB의 하루 1회 unique 인덱스에 걸린 경우
    if (e instanceof Error && 'code' in e && e.code === '23505') {
      return NextResponse.json({ error: '오늘 이미 이 메뉴를 확인했어요' }, { status: 409 })
    }
    if (e instanceof Error && 'code' in e && e.code === '23503') {
      return NextResponse.json({ error: '없는 메뉴입니다' }, { status: 404 })
    }
    throw e
  }
}
