import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireAdmin } from '@/lib/admin-auth'
import { isValidUserId } from '@/lib/user'

// 가게 상세 — 메뉴 전체(내린 것 포함)와 각 메뉴의 가격 이력.
// 편집 화면이 쓴다. 지도용 /api/stores와 달리 is_available=false도 보여줘야
// "내린 메뉴를 다시 올리기"가 가능하다.
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const id = req.nextUrl.searchParams.get('id')
  if (!isValidUserId(id)) return NextResponse.json({ error: 'id가 올바르지 않습니다' }, { status: 400 })

  const [store] = await sql`
    select id, name, category, road_address, district, lat, lng, is_open, source
    from stores where id = ${id}
  `
  if (!store) return NextResponse.json({ error: '없는 가게입니다' }, { status: 404 })

  const menus = await sql`
    select
      m.id, m.name, m.price, m.is_available, m.image_url, m.verified_at, m.source,
      (
        select json_agg(json_build_object('old', h.old_price, 'new', h.new_price, 'at', h.changed_at, 'source', h.source)
               order by h.changed_at desc)
        from menu_price_history h where h.menu_id = m.id
      ) as price_history
    from menus m
    where m.store_id = ${id}
    order by m.is_available desc, m.sort_order, m.price
  `

  // 이 가게의 리뷰 — 콘솔에서 유해 리뷰를 찾아 내리려면 상태 무관 전체가 보여야 한다.
  // (지도용 GET과 달리 pending·rejected까지 포함.) user_id는 사칭 방지로 안 보낸다.
  const reviews = await sql`
    select r.id, r.comment, r.rating, r.tags, r.status, r.flagged_reason as reason, r.created_at,
           m.name as menu_name
    from menu_reviews r
    join menus m on m.id = r.menu_id
    where m.store_id = ${id}
    order by r.created_at desc
    limit 100
  `

  return NextResponse.json({ store, menus, reviews })
}
