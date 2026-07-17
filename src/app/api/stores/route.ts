import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'

// 지도 bbox 안에서 조건에 맞는 메뉴를 가진 가게를 돌려준다.
// 마커는 가게 단위, 목록은 토글에 따라 가게/메뉴로 펼쳐지므로
// 한 번의 응답에 가게와 그 메뉴를 함께 담아 두 보기 모두를 커버한다.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams

  const minLat = parseFloat(p.get('minLat') ?? '')
  const maxLat = parseFloat(p.get('maxLat') ?? '')
  const minLng = parseFloat(p.get('minLng') ?? '')
  const maxLng = parseFloat(p.get('maxLng') ?? '')
  if (![minLat, maxLat, minLng, maxLng].every(Number.isFinite)) {
    return NextResponse.json({ error: 'bbox 파라미터가 필요합니다' }, { status: 400 })
  }

  const maxPrice = parseInt(p.get('maxPrice') ?? '10000', 10)
  const categories = p.getAll('category').filter(Boolean)
  // 마커가 수천 개면 지도가 죽는다. 상한을 두고 잘렸는지 알려준다.
  const limit = Math.min(parseInt(p.get('limit') ?? '300', 10), 500)

  const rows = await sql<
    {
      id: string; name: string; category: string | null; road_address: string | null
      lat: number; lng: number; source: string
      menus: { id: string; name: string; price: number; is_available: boolean; verified_at: string }[]
      cheapest: number
    }[]
  >`
    select
      s.id, s.name, s.category, s.road_address, s.lat, s.lng, s.source,
      min(m.price)::int as cheapest,
      json_agg(
        json_build_object(
          'id', m.id, 'name', m.name, 'price', m.price,
          'is_available', m.is_available, 'verified_at', m.verified_at
        ) order by m.price
      ) as menus
    from stores s
    join menus m on m.store_id = s.id
    where s.is_open
      and s.lat between ${minLat} and ${maxLat}
      and s.lng between ${minLng} and ${maxLng}
      and m.is_available
      and m.price <= ${maxPrice}
      ${categories.length ? sql`and s.category = any(${categories})` : sql``}
    group by s.id
    order by min(m.price)
    limit ${limit}
  `

  return NextResponse.json({
    stores: rows,
    // 목록이 잘렸으면 UI가 "더 확대하세요"를 띄울 수 있어야 한다
    truncated: rows.length >= limit,
  })
}
