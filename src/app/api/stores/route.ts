import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { expandCategories } from '@/lib/categories'
import { CLUSTER_ZOOM, gridSizeForZoom } from '@/lib/cluster'
import { bboxAround, EARTH_R } from '@/lib/geo'

type Args = {
  centerLat: number; centerLng: number; radiusM: number
  minLat: number; maxLat: number; minLng: number; maxLng: number
  maxPrice: number; categories: string[]
}

/**
 * 중심에서의 거리(m). Postgres 내장 삼각함수만 쓰므로 PostGIS가 필요 없다.
 * 앞의 lat/lng between이 인덱스로 후보를 좁힌 뒤에야 이 식이 평가된다.
 */
const distance = (lat: number, lng: number) => sql`
  ${EARTH_R} * 2 * asin(sqrt(
    power(sin(radians(s.lat - ${lat}) / 2), 2) +
    cos(radians(${lat})) * cos(radians(s.lat)) *
    power(sin(radians(s.lng - ${lng}) / 2), 2)
  ))`

/** 반경 안 + 조건에 맞는 메뉴를 가진 가게로 좁히는 공통 where절 */
const withinRadius = (a: Args) => sql`
  s.is_open
  and s.lat between ${a.minLat} and ${a.maxLat}
  and s.lng between ${a.minLng} and ${a.maxLng}
  and ${distance(a.centerLat, a.centerLng)} <= ${a.radiusM}
  and m.is_available
  and m.price <= ${a.maxPrice}
  ${a.categories.length ? sql`and s.category = any(${a.categories})` : sql``}`

/**
 * 격자 클러스터링.
 * 좌표를 줌 레벨에 맞는 격자에 떨어뜨려 세고, 각 격자의 무게중심을 대표점으로 쓴다.
 */
async function fetchClusters(a: Args, zoom: number) {
  const g = gridSizeForZoom(zoom)
  return sql<{ lat: number; lng: number; count: number; cheapest: number }[]>`
    select
      avg(s.lat)::float as lat,
      avg(s.lng)::float as lng,
      count(distinct s.id)::int as count,
      min(m.price)::int as cheapest
    from stores s
    join menus m on m.store_id = s.id
    where ${withinRadius(a)}
    group by floor(s.lat / ${g}), floor(s.lng / ${g})
    order by count(distinct s.id) desc
    -- 클러스터 한 건은 숫자 4개뿐이라 payload가 가볍다. 상한을 낮게 잡으면
    -- 격자가 조용히 잘려서 "이 화면에 N곳"이 실제보다 작게 나온다 — 사용자에게 거짓말이 된다.
    limit 800
  `
}

// 화면 중심에서 반경 안의, 조건에 맞는 메뉴를 가진 가게를 돌려준다.
//
// 왜 사각형(bbox)이 아니라 원인가: 화면에 반경 원을 그려 "여기까지 찾았다"고 말하려면
// 실제 검색도 원이어야 한다. 사각형으로 찾으면 원 밖 모서리의 가게가 목록에 섞인다.
//
// 마커는 가게 단위, 목록은 토글에 따라 가게/메뉴로 펼쳐지므로
// 한 번의 응답에 가게와 그 메뉴를 함께 담아 두 보기 모두를 커버한다.
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams

  const centerLat = parseFloat(p.get('centerLat') ?? '')
  const centerLng = parseFloat(p.get('centerLng') ?? '')
  const radiusM = parseFloat(p.get('radiusM') ?? '')
  if (![centerLat, centerLng, radiusM].every(Number.isFinite) || radiusM <= 0) {
    return NextResponse.json({ error: 'centerLat, centerLng, radiusM이 필요합니다' }, { status: 400 })
  }

  // 인덱스(lat,lng)를 타기 위한 사각형 선별. 실제 원 판정은 위 distance가 한다.
  const box = bboxAround(centerLat, centerLng, radiusM)
  const maxPrice = parseInt(p.get('maxPrice') ?? '10000', 10)
  // 화면의 "중식" 같은 라벨을 공공데이터의 "중국식" 같은 실제 값으로 넓힌다
  const categories = expandCategories(p.getAll('category').filter(Boolean))
  const limit = Math.min(parseInt(p.get('limit') ?? '300', 10), 500)
  const zoom = parseInt(p.get('zoom') ?? '15', 10)

  const args: Args = { centerLat, centerLng, radiusM, ...box, maxPrice, categories }

  // 줌아웃 상태에서 가격 마커를 수백 개 뿌리면 서로 겹쳐 아무것도 못 읽는다.
  // 그 거리에서 필요한 정보는 "여기 몇 곳 있나"지 "얼마인가"가 아니다.
  // 클러스터링은 서버에서 한다 — 클라이언트로 수천 건을 보내는 것 자체가 낭비다.
  if (zoom < CLUSTER_ZOOM) {
    return NextResponse.json({
      mode: 'cluster',
      clusters: await fetchClusters(args, zoom),
      stores: [],
      truncated: false,
      storesWithoutMenus: 0,
    })
  }

  const rows = await sql<
    {
      id: string; name: string; category: string | null; road_address: string | null
      lat: number; lng: number; source: string; distance_m: number
      menus: {
        id: string; name: string; price: number; is_available: boolean
        verified_at: string; image_url: string | null
        rating: number | null; rating_count: number
      }[]
      cheapest: number
    }[]
  >`
    select
      s.id, s.name, s.category, s.road_address, s.lat, s.lng, s.source,
      min(${distance(centerLat, centerLng)})::float as distance_m,
      min(m.price)::int as cheapest,
      json_agg(
        json_build_object(
          'id', m.id, 'name', m.name, 'price', m.price,
          'is_available', m.is_available, 'verified_at', m.verified_at,
          'image_url', m.image_url,
          'rating', r.avg_rating, 'rating_count', r.n
        ) order by m.price
      ) as menus
    from stores s
    join menus m on m.store_id = s.id
    -- 평점은 메뉴 단위다. 같은 집이라도 김치찌개는 훌륭하고 돈까스는 별로일 수 있다.
    left join lateral (
      select round(avg(rating)::numeric, 1)::float as avg_rating, count(*)::int as n
      from menu_reviews mr where mr.menu_id = m.id and mr.rating is not null
    ) r on true
    where ${withinRadius(args)}
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
      select count(*)::int as n from stores s
      where s.is_open
        and s.lat between ${box.minLat} and ${box.maxLat}
        and s.lng between ${box.minLng} and ${box.maxLng}
        and ${distance(centerLat, centerLng)} <= ${radiusM}
    `
    storesWithoutMenus = c.n
  }

  return NextResponse.json({
    mode: 'store',
    stores: rows,
    // 목록이 잘렸으면 UI가 "더 확대하세요"를 띄울 수 있어야 한다
    truncated: rows.length >= limit,
    storesWithoutMenus,
  })
}
