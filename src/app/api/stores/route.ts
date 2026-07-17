import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { expandCategories } from '@/lib/categories'

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
  // 화면의 "중식" 같은 라벨을 공공데이터의 "중국식" 같은 실제 값으로 넓힌다
  const categories = expandCategories(p.getAll('category').filter(Boolean))
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

  // 결과가 없을 때 "이 동네엔 식당이 없다"로 읽히면 안 된다.
  // 공공데이터로 서울 전역 가게는 이미 깔려 있고 메뉴만 아직 없는 것이므로,
  // 그 사실을 UI가 정직하게 말할 수 있도록 가게 수를 함께 준다.
  let storesWithoutMenus = 0
  if (rows.length === 0) {
    const [c] = await sql<{ n: number }[]>`
      select count(*)::int as n from stores
      where is_open
        and lat between ${minLat} and ${maxLat}
        and lng between ${minLng} and ${maxLng}
    `
    storesWithoutMenus = c.n
  }

  return NextResponse.json({
    stores: rows,
    // 목록이 잘렸으면 UI가 "더 확대하세요"를 띄울 수 있어야 한다
    truncated: rows.length >= limit,
    storesWithoutMenus,
  })
}
