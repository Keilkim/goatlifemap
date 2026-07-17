// 데모 데이터 시드 — UI를 눈으로 확인하기 위한 가짜 데이터.
//
// 중요: 여기 나오는 가게명·메뉴·가격은 전부 가공의 것이다. 실제 업소가 아니다.
// source='demo'로 표시되며 UI에 "데모 데이터" 배지가 뜬다.
// 진짜 데이터는 SEOUL_API_KEY로 scripts/ingest-seoul.mjs를 돌려서 넣는다.
//
// 사용법: node scripts/seed-demo.mjs [--clear]

import postgres from 'postgres'

const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/jumsim'
const sql = postgres(DB, { max: 4 })

// 홍대·신촌·합정 일대. 데이터 밀집지역부터 채운다는 전략에 맞춘 범위.
const AREAS = [
  { name: '홍대', lat: 37.5563, lng: 126.9236 },
  { name: '신촌', lat: 37.5552, lng: 126.9368 },
  { name: '합정', lat: 37.5495, lng: 126.9137 },
  { name: '연남', lat: 37.5637, lng: 126.9256 },
]

const CATEGORIES = [
  { cat: '한식', menus: [['김치찌개', 7000], ['제육덮밥', 8500], ['된장찌개', 7000], ['불고기백반', 9500], ['순두부찌개', 7500]] },
  { cat: '중식', menus: [['짜장면', 6500], ['짬뽕', 8000], ['볶음밥', 8000], ['탕수육(소)', 12000]] },
  { cat: '분식', menus: [['떡볶이', 4500], ['참치김밥', 4000], ['라면', 4000], ['돈까스', 8500], ['쫄면', 6000]] },
  { cat: '일식', menus: [['돈코츠라멘', 9500], ['규동', 8500], ['우동', 7000], ['연어덮밥', 12000]] },
  { cat: '경양식', menus: [['오므라이스', 9000], ['함박스테이크', 11000], ['크림파스타', 10500]] },
]

const PREFIX = ['가온', '나루', '다솜', '라온', '마루', '바다', '사랑', '아침', '자유', '차오름', '하늘', '푸른', '한결', '온새미', '들꽃']
const SUFFIX = ['식당', '집', '반점', '분식', '주방', '식탁', '밥상']

// 재현 가능한 난수. 매번 같은 데모 데이터가 나오도록 고정 시드를 쓴다.
let seed = 20260717
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const pick = (arr) => arr[Math.floor(rand() * arr.length)]

if (process.argv.includes('--clear')) {
  await sql`delete from stores where source = 'demo'`
  console.log('기존 데모 데이터 삭제')
}

const stores = []
let n = 0
for (const area of AREAS) {
  for (let i = 0; i < 16; i++) {
    const c = pick(CATEGORIES)
    // 중심에서 약 ±700m 흩뿌린다
    const lat = area.lat + (rand() - 0.5) * 0.013
    const lng = area.lng + (rand() - 0.5) * 0.016
    stores.push({
      license_no: `DEMO-${String(++n).padStart(4, '0')}`,
      name: `${pick(PREFIX)}${pick(SUFFIX)} ${area.name}점`,
      road_address: `서울특별시 마포구 ${area.name}로 ${Math.floor(rand() * 200) + 1}`,
      lot_address: null,
      category: c.cat,
      lat, lng,
      is_open: true,
      source: 'demo',
      _menus: c.menus,
    })
  }
}

const inserted = await sql`
  insert into stores ${sql(stores, 'license_no', 'name', 'road_address', 'lot_address', 'category', 'lat', 'lng', 'is_open', 'source')}
  on conflict (license_no) do update set name = excluded.name, lat = excluded.lat, lng = excluded.lng
  returning id, license_no
`

const byLicense = new Map(inserted.map((r) => [r.license_no, r.id]))
const menus = []
for (const s of stores) {
  const storeId = byLicense.get(s.license_no)
  // 가게당 대표 메뉴 2~4개
  const count = 2 + Math.floor(rand() * 3)
  const chosen = [...s._menus].sort(() => rand() - 0.5).slice(0, count)
  chosen.forEach(([name, base], idx) => {
    // 가격을 가게마다 ±15% 흔들어 필터가 의미있게 동작하도록 한다
    const price = Math.round((base * (0.85 + rand() * 0.3)) / 500) * 500
    menus.push({
      store_id: storeId, name, price, sort_order: idx,
      is_available: rand() > 0.05,
      source: 'demo',
      // 신뢰도 UI를 보려면 확인일이 제각각이어야 한다
      verified_at: new Date(Date.now() - Math.floor(rand() * 30) * 86400000),
    })
  })
}

await sql`
  insert into menus ${sql(menus, 'store_id', 'name', 'price', 'sort_order', 'is_available', 'source', 'verified_at')}
  on conflict (store_id, name) do update set price = excluded.price, verified_at = excluded.verified_at
`

const [stat] = await sql`
  select
    (select count(*)::int from stores where source='demo') as stores,
    (select count(*)::int from menus where source='demo') as menus,
    (select count(*)::int from menus where source='demo' and price <= 10000) as under10k
`
console.log(`데모 데이터 완료`)
console.log(`  가게 ${stat.stores}곳 · 메뉴 ${stat.menus}개 (만원 이하 ${stat.under10k}개)`)
console.log(`  전부 가공의 데이터. 진짜 데이터는 SEOUL_API_KEY로 ingest-seoul.mjs 실행.`)
await sql.end()
