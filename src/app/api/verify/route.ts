import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { ensureUser, isValidUserId } from '@/lib/user'

// 메뉴 검증 제보 + 포인트 적립.
//
// 포인트는 클라이언트가 보내는 값을 절대 믿지 않고 서버가 정한 표에 따라서만 준다.
// 하루 1회 제한은 DB의 unique 인덱스(menu_verifications_daily_unique)가 강제하므로
// 이 라우트를 우회해도 뚫리지 않는다.
const POINTS: Record<string, number> = {
  price_ok: 5,
  still_selling: 5,
  sold_out: 20,
  price_changed: 20,
}

export async function POST(req: NextRequest) {
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

  await ensureUser(userId)

  try {
    const result = await sql.begin(async (tx) => {
      const [inserted] = await tx<{ id: string }[]>`
        insert into menu_verifications (menu_id, user_id, kind, reported_price)
        values (${menuId}, ${userId}, ${kind}, ${kind === 'price_changed' ? reportedPrice! : null})
        returning id
      `

      // 제보 내용을 메뉴에 반영한다. 가격 변경과 품절은 즉시 반영하되,
      // 단독 제보로 가격을 바꾸는 건 위험하므로 가격은 확인일만 갱신하고
      // 실제 가격 반영은 관리자/교차검증 단계로 미룬다.
      if (kind === 'sold_out') {
        await tx`update menus set is_available = false, verified_at = now(), updated_at = now() where id = ${menuId!}`
      } else if (kind === 'price_ok' || kind === 'still_selling') {
        await tx`update menus set verified_at = now(), updated_at = now() where id = ${menuId!}`
      } else if (kind === 'price_changed') {
        await tx`update menus set updated_at = now() where id = ${menuId!}`
      }

      const [user] = await tx<{ points: number }[]>`
        update app_users set points = points + ${POINTS[kind]}
        where id = ${userId!}
        returning points
      `
      return { id: inserted.id, points: user.points, earned: POINTS[kind] }
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
