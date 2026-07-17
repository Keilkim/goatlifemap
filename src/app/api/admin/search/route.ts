import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'

// 관리자용 가게 검색.
// 공공데이터로 서울 전역 가게가 이미 깔려 있으므로, 메뉴를 넣을 때
// 가게를 새로 만들 필요 없이 이름/주소로 찾아 붙이기만 하면 된다.
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')?.trim()
  if (!q || q.length < 2) return NextResponse.json({ stores: [] })

  const rows = await sql`
    select s.id, s.name, s.category, s.road_address, s.lat, s.lng, s.source,
           count(m.id)::int as menu_count
    from stores s
    left join menus m on m.store_id = s.id
    where s.is_open and (s.name ilike ${'%' + q + '%'} or s.road_address ilike ${'%' + q + '%'})
    group by s.id
    order by
      -- 이름이 정확히 시작하는 것부터
      case when s.name ilike ${q + '%'} then 0 else 1 end,
      count(m.id) desc,
      s.name
    limit 20
  `
  return NextResponse.json({ stores: rows })
}
