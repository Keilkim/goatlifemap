// 서울시 일반음식점 인허가 공공데이터 → stores 테이블 적재
//
// 데이터: 서울 열린데이터광장 LOCALDATA_072404 (공공누리 1유형, 상업적 이용/변경 가능)
// 좌표: EPSG:5174 → WGS84 변환 (src/lib/coords.ts와 동일한 정의를 쓴다)
//
// 사용법:
//   SEOUL_API_KEY=발급받은키 node scripts/ingest-seoul.mjs
//   SEOUL_API_KEY=... node scripts/ingest-seoul.mjs --limit 5000   (일부만)
//
// 키 발급: https://data.seoul.go.kr → 로그인 → 인증키 신청 (무료, 즉시)

import proj4 from 'proj4'
import postgres from 'postgres'

const EPSG5174 =
  '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 ' +
  '+ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43'
const WGS84 = '+proj=longlat +datum=WGS84 +no_defs'
const SEOUL = { minLat: 37.4, maxLat: 37.72, minLng: 126.75, maxLng: 127.19 }

const KEY = process.env.SEOUL_API_KEY
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/jumsim'
const limitArg = process.argv.indexOf('--limit')
const LIMIT = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity

if (!KEY) {
  console.error(`
SEOUL_API_KEY가 없습니다.

  1. https://data.seoul.go.kr 접속 → 회원가입/로그인
  2. 상단 "Open API" → "인증키 신청" (무료, 즉시 발급)
  3. SEOUL_API_KEY=발급키 node scripts/ingest-seoul.mjs

키 없이 UI를 먼저 보려면:  node scripts/seed-demo.mjs
`)
  process.exit(1)
}

// sample 키는 5건 제한, 실제 키는 1000건까지 한 번에 받는다.
const PAGE = KEY === 'sample' ? 5 : 1000
const sql = postgres(DB, { max: 4 })

function convert(xRaw, yRaw) {
  const x = parseFloat(xRaw), y = parseFloat(yRaw)
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0 || y === 0) return null
  try {
    const [lng, lat] = proj4(EPSG5174, WGS84, [x, y])
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (lat < SEOUL.minLat || lat > SEOUL.maxLat || lng < SEOUL.minLng || lng > SEOUL.maxLng) return null
    return { lat, lng }
  } catch {
    return null
  }
}

async function fetchPage(start, end) {
  const url = `http://openapi.seoul.go.kr:8088/${KEY}/json/LOCALDATA_072404/${start}/${end}/`
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
      const text = await res.text()
      if (!text.trim().startsWith('{')) {
        const msg = text.match(/<MESSAGE><!\[CDATA\[(.*?)\]\]>/s)?.[1] ?? text.slice(0, 120)
        throw new Error(msg.trim())
      }
      const body = JSON.parse(text).LOCALDATA_072404
      if (body?.RESULT?.CODE && !['INFO-000'].includes(body.RESULT.CODE)) {
        throw new Error(`${body.RESULT.CODE}: ${body.RESULT.MESSAGE}`)
      }
      return body
    } catch (e) {
      if (attempt === 3) throw e
    }
  }
}

const first = await fetchPage(1, 1)
const total = Math.min(first.list_total_count, LIMIT)
console.log(`서울 일반음식점 전체 ${first.list_total_count.toLocaleString()}건 중 ${total.toLocaleString()}건 처리\n`)

let seen = 0, inserted = 0, skippedClosed = 0, skippedNoCoord = 0

for (let start = 1; start <= total; start += PAGE) {
  const end = Math.min(start + PAGE - 1, total)
  const body = await fetchPage(start, end)
  const rows = body?.row ?? []
  if (!rows.length) break

  const batch = []
  for (const r of rows) {
    seen++
    // 폐업한 가게는 지도에 띄울 이유가 없다. 전체의 상당수를 차지한다.
    if (r.DTLSTATENM?.trim() !== '영업') { skippedClosed++; continue }
    const pt = convert(r.X, r.Y)
    if (!pt) { skippedNoCoord++; continue }

    batch.push({
      license_no: r.MGTNO?.trim(),
      name: r.BPLCNM?.trim(),
      road_address: r.RDNWHLADDR?.trim() || null,
      lot_address: r.SITEWHLADDR?.trim() || null,
      category: r.UPTAENM?.trim() || null,
      lat: pt.lat,
      lng: pt.lng,
      is_open: true,
      source: 'seoul_opendata',
    })
  }

  if (batch.length) {
    // 재적재 시 중복이 아니라 갱신이 되도록 관리번호 기준 upsert.
    await sql`
      insert into stores ${sql(batch, 'license_no', 'name', 'road_address', 'lot_address', 'category', 'lat', 'lng', 'is_open', 'source')}
      on conflict (license_no) do update set
        name = excluded.name,
        road_address = excluded.road_address,
        lot_address = excluded.lot_address,
        category = excluded.category,
        lat = excluded.lat,
        lng = excluded.lng,
        is_open = excluded.is_open,
        updated_at = now()
    `
    inserted += batch.length
  }

  if (start % 10000 < PAGE || end >= total) {
    process.stdout.write(`\r  ${seen.toLocaleString()}/${total.toLocaleString()} 처리 · ${inserted.toLocaleString()}건 적재`)
  }
}

const [{ count }] = await sql`select count(*)::int as count from stores`
console.log(`\n\n완료`)
console.log(`  적재/갱신 : ${inserted.toLocaleString()}건`)
console.log(`  폐업 제외 : ${skippedClosed.toLocaleString()}건`)
console.log(`  좌표없음  : ${skippedNoCoord.toLocaleString()}건`)
console.log(`  stores 총 : ${count.toLocaleString()}건`)
await sql.end()
