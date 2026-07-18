import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireAdmin } from '@/lib/admin-auth'
import { isValidUserId } from '@/lib/user'

// 운영자 메뉴 CRUD.
//
// 이 라우트는 운영자가 직접 확인한 메뉴를 입력하는 곳이며 자동 수집기의 투입구가 아니다.
// 외부 자료를 쓸 때는 출처별 최신 이용조건을 별도로 확인한다.
//
// 가격이 바뀌면 menu_price_history에 한 줄을 남긴다 — "언제 얼마에서 얼마로"를 알아야
// 변동을 보여주고 노후화를 판단할 수 있다.

// 여러 메뉴 한 번에 등록/갱신 (가게 상세에서 대표 메뉴 채우기)
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req)
  if (denied) return denied

  let body: { storeId?: string; menus?: { name: string; price: number }[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const { storeId, menus } = body
  if (!isValidUserId(storeId)) return NextResponse.json({ error: 'storeId가 올바르지 않습니다' }, { status: 400 })
  if (!Array.isArray(menus) || menus.length === 0) {
    return NextResponse.json({ error: '메뉴를 하나 이상 입력하세요' }, { status: 400 })
  }
  if (menus.length > 20) return NextResponse.json({ error: '한 번에 20개까지' }, { status: 400 })

  const clean = menus
    .map((m) => ({ name: String(m.name ?? '').trim(), price: Number(m.price) }))
    .filter((m) => m.name.length > 0 && Number.isInteger(m.price) && m.price >= 0 && m.price <= 1_000_000)
  if (!clean.length) return NextResponse.json({ error: '유효한 메뉴가 없습니다' }, { status: 400 })
  if (new Set(clean.map((menu) => menu.name)).size !== clean.length) {
    return NextResponse.json({ error: '같은 메뉴 이름을 한 요청에 두 번 넣을 수 없습니다' }, { status: 400 })
  }

  const [store] = await sql<{ id: string }[]>`select id from stores where id = ${storeId}`
  if (!store) return NextResponse.json({ error: '없는 가게입니다' }, { status: 404 })

  await sql.begin(async (tx) => {
    await tx`select set_config('app.change_source', 'admin', true)`
    for (const [i, m] of clean.entries()) {
      await tx`
        insert into menus (store_id, name, price, sort_order, is_available, source, verified_at)
        values (${storeId}, ${m.name}, ${m.price}, ${i}, true, 'manual', now())
        on conflict (store_id, name) do update set
          price = excluded.price, sort_order = excluded.sort_order,
          is_available = true, source = 'manual', verified_at = now(), updated_at = now()
      `
      // 가격/신규/재판매 이력은 DB trigger가 누락 없이 같은 트랜잭션에 기록한다.
    }
  })

  const saved = await sql`select id, name, price, is_available from menus where store_id = ${storeId} order by sort_order, price`
  return NextResponse.json({ ok: true, menus: saved })
}

// 개별 메뉴 수정 (이름·가격). 가격이 바뀌면 이력을 남긴다.
export async function PATCH(req: NextRequest) {
  const denied = requireAdmin(req)
  if (denied) return denied

  let body: { id?: string; name?: string; price?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  const { id } = body
  if (!isValidUserId(id)) return NextResponse.json({ error: 'id가 올바르지 않습니다' }, { status: 400 })

  const name = body.name?.trim()
  const price = body.price
  if (price != null && (!Number.isInteger(price) || price < 0 || price > 1_000_000)) {
    return NextResponse.json({ error: '가격이 올바르지 않습니다' }, { status: 400 })
  }

  const updated = await sql.begin(async (tx) => {
    await tx`select set_config('app.change_source', 'admin', true)`
    const [m] = await tx<{ id: string; price: number }[]>`select id, price from menus where id = ${id} for update`
    if (!m) return null
    const [row] = await tx`
      update menus set
        name = coalesce(${name ?? null}, name),
        price = coalesce(${price ?? null}, price),
        source = 'manual',
        verified_at = now(), updated_at = now()
      where id = ${id}
      returning id, name, price
    `
    return row
  })

  if (!updated) return NextResponse.json({ error: '없는 메뉴입니다' }, { status: 404 })
  return NextResponse.json({ ok: true, menu: updated })
}

// 메뉴 내림. 삭제하면 가격·제보 관계까지 사라질 수 있으므로 항상 soft delete한다.
export async function DELETE(req: NextRequest) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const id = req.nextUrl.searchParams.get('id')
  const hard = req.nextUrl.searchParams.get('hard') === 'true'
  if (!isValidUserId(id)) return NextResponse.json({ error: 'id가 올바르지 않습니다' }, { status: 400 })
  if (hard) {
    return NextResponse.json({ error: '감사 이력 보존을 위해 영구 삭제는 지원하지 않습니다' }, { status: 400 })
  }

  const changed = await sql.begin(async (tx) => {
    await tx`select set_config('app.change_source', 'admin', true)`
    const [row] = await tx`
      update menus set is_available = false, source = 'manual', updated_at = now()
      where id = ${id}
      returning id
    `
    return row
  })
  if (!changed) return NextResponse.json({ error: '없는 메뉴입니다' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
