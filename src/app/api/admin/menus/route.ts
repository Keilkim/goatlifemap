import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'

// 관리자용 메뉴 등록/수정.
//
// 이 라우트는 "사람이 직접 확인한 메뉴"만 받는다. 자동 크롤러의 투입구가 아니다.
// 이유는 legal 조사 결과에 있다 — 저작권법 93조 2항은 개별 소재라도 "반복적·체계적"
// 복제면 상당한 부분의 복제로 간주하고, 잡코리아 v 사람인에서 서울고법이
// 2억 5천만원 배상을 명했다. 반면 93조 4항은 보호가 "소재 그 자체에는 미치지
// 아니한다"고 한다. 즉 사람이 개별 가게를 확인해 넣는 건 보호 범위 밖이다.
export async function POST(req: NextRequest) {
  let body: { storeId?: string; menus?: { name: string; price: number }[]; note?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const { storeId, menus } = body
  if (!storeId) return NextResponse.json({ error: 'storeId가 필요합니다' }, { status: 400 })
  if (!Array.isArray(menus) || menus.length === 0) {
    return NextResponse.json({ error: '메뉴를 하나 이상 입력하세요' }, { status: 400 })
  }
  if (menus.length > 20) {
    return NextResponse.json({ error: '한 번에 20개까지' }, { status: 400 })
  }

  const clean = menus
    .map((m) => ({ name: String(m.name ?? '').trim(), price: Number(m.price) }))
    .filter((m) => m.name.length > 0 && Number.isInteger(m.price) && m.price >= 0 && m.price <= 1_000_000)

  if (!clean.length) return NextResponse.json({ error: '유효한 메뉴가 없습니다' }, { status: 400 })

  const [store] = await sql<{ id: string }[]>`select id from stores where id = ${storeId}`
  if (!store) return NextResponse.json({ error: '없는 가게입니다' }, { status: 404 })

  const rows = clean.map((m, i) => ({
    store_id: storeId,
    name: m.name,
    price: m.price,
    sort_order: i,
    is_available: true,
    source: 'manual',
    verified_at: new Date(),
  }))

  await sql`
    insert into menus ${sql(rows, 'store_id', 'name', 'price', 'sort_order', 'is_available', 'source', 'verified_at')}
    on conflict (store_id, name) do update set
      price = excluded.price,
      sort_order = excluded.sort_order,
      is_available = true,
      verified_at = now(),
      updated_at = now()
  `

  const saved = await sql`select id, name, price from menus where store_id = ${storeId} order by sort_order, price`
  return NextResponse.json({ ok: true, menus: saved })
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id가 필요합니다' }, { status: 400 })
  await sql`delete from menus where id = ${id}`
  return NextResponse.json({ ok: true })
}
