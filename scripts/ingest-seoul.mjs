// 서울시 일반음식점 인허가 공공데이터 → stores 테이블 적재
//
// 데이터: 서울 열린데이터광장 LOCALDATA_072404_* (공공누리 1유형, 상업적 이용/변경 가능)
// 좌표: EPSG:5174 → WGS84 변환 (src/lib/coords.ts와 동일한 정의)
//
// 25개 구를 하나씩 돌면서 적재한다. 관리번호 기준 upsert이므로 몇 번을 다시 돌려도 안전하다.
//
// 사용법:
//   node scripts/ingest-seoul.mjs                # 서울 전역 25개 구
//   node scripts/ingest-seoul.mjs --gu 마포구     # 특정 구만
//   node scripts/ingest-seoul.mjs --dry          # DB에 쓰지 않고 집계만
//
// 키 발급: https://data.seoul.go.kr → 로그인 → Open API → 인증키 신청 (무료, 즉시)

import proj4 from 'proj4'
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { SEOUL_GU } from './seoul-gu.mjs'

// .env를 직접 읽는다 (Next.js 밖에서 도는 스크립트라 자동 로딩이 안 된다)
try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch { /* .env가 없으면 환경변수를 그대로 쓴다 */ }

const EPSG5174 =
  '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 ' +
  '+ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43'
const WGS84 = '+proj=longlat +datum=WGS84 +no_defs'
const SEOUL = { minLat: 37.4, maxLat: 37.72, minLng: 126.75, maxLng: 127.19 }

const KEY = process.env.SEOUL_API_KEY
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/jumsim'
const argv = process.argv
const DRY = argv.includes('--dry')
const guArg = argv.indexOf('--gu') > -1 ? argv[argv.indexOf('--gu') + 1] : null

if (!KEY) {
  console.error(`
SEOUL_API_KEY가 없습니다.

  1. https://data.seoul.go.kr 접속 → 회원가입/로그인
  2. Open API → 인증키 신청 (무료, 즉시 발급)
  3. .env에 SEOUL_API_KEY=발급키 추가

키 없이 UI를 먼저 보려면:  node scripts/seed-demo.mjs
`)
  process.exit(1)
}

const targets = guArg ? SEOUL_GU.filter((g) => g.name === guArg) : SEOUL_GU
if (!targets.length) {
  console.error(`'${guArg}'는 서울 자치구가 아닙니다.\n가능: ${SEOUL_GU.map((g) => g.name).join(', ')}`)
  process.exit(1)
}

const PAGE = 1000 // 실제 키의 1회 최대 건수
const sql = postgres(DB, { max: 4 })

function convert(xRaw, yRaw) {
  const x = parseFloat(xRaw), y = parseFloat(yRaw)
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0 || y === 0) return null
  try {
    const [lng, lat] = proj4(EPSG5174, WGS84, [x, y])
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    // 좌표가 서울 밖이면 원본이 깨진 것이다. 지도에 엉뚱한 마커를 찍느니 버린다.
    if (lat < SEOUL.minLat || lat > SEOUL.maxLat || lng < SEOUL.minLng || lng > SEOUL.maxLng) return null
    return { lat, lng }
  } catch {
    return null
  }
}

async function fetchPage(service, start, end) {
  const url = `http://openapi.seoul.go.kr:8088/${KEY}/json/${service}/${start}/${end}/`
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(40000) })
      const text = await res.text()
      if (!text.trim().startsWith('{')) {
        const msg = text.match(/<MESSAGE><!\[CDATA\[(.*?)\]\]>/s)?.[1] ?? text.slice(0, 100)
        throw new Error(msg.trim().replace(/\s+/g, ' '))
      }
      const body = JSON.parse(text)[service]
      const code = body?.RESULT?.CODE
      if (code && code !== 'INFO-000') throw new Error(`${code}: ${body.RESULT.MESSAGE}`)
      return body
    } catch (e) {
      lastErr = e
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
  throw lastErr
}

const stat = { seen: 0, saved: 0, closed: 0, noCoord: 0, outside: 0 }
const categories = new Map()

console.log(`대상: ${targets.length}개 구${DRY ? ' (dry run — DB에 쓰지 않음)' : ''}\n`)

for (const gu of targets) {
  const service = `LOCALDATA_072404_${gu.code}`
  const first = await fetchPage(service, 1, 1)
  const total = first.list_total_count
  let saved = 0, open = 0

  for (let start = 1; start <= total; start += PAGE) {
    const body = await fetchPage(service, start, Math.min(start + PAGE - 1, total))
    const rows = body?.row ?? []
    if (!rows.length) break

    const batch = []
    for (const r of rows) {
      stat.seen++
      // 폐업한 가게를 지도에 띄울 이유가 없다. 전체의 절반 이상이다.
      if (r.DTLSTATENM?.trim() !== '영업') { stat.closed++; continue }

      const cat = r.UPTAENM?.trim() || null
      if (cat) categories.set(cat, (categories.get(cat) ?? 0) + 1)
      open++

      const xr = r.X?.trim(), yr = r.Y?.trim()
      if (!xr || !yr) { stat.noCoord++; continue }
      const pt = convert(xr, yr)
      if (!pt) { stat.outside++; continue }

      batch.push({
        license_no: r.MGTNO?.trim(),
        name: r.BPLCNM?.trim(),
        road_address: r.RDNWHLADDR?.trim() || null,
        lot_address: r.SITEWHLADDR?.trim() || null,
        category: cat,
        district: gu.name,
        lat: pt.lat,
        lng: pt.lng,
        is_open: true,
        source: 'seoul_opendata',
      })
    }

    if (batch.length && !DRY) {
      await sql`
        insert into stores ${sql(batch, 'license_no', 'name', 'road_address', 'lot_address', 'category', 'district', 'lat', 'lng', 'is_open', 'source')}
        on conflict (license_no) do update set
          name = excluded.name,
          road_address = excluded.road_address,
          lot_address = excluded.lot_address,
          category = excluded.category,
          district = excluded.district,
          lat = excluded.lat,
          lng = excluded.lng,
          is_open = excluded.is_open,
          updated_at = now()
      `
    }
    saved += batch.length
    stat.saved += batch.length
    process.stdout.write(`\r  ${gu.name.padEnd(6)} ${String(Math.min(start + PAGE - 1, total)).padStart(6)}/${total}  영업 ${open} · 적재 ${saved}   `)
  }
  console.log(`\r  ${gu.name.padEnd(6)} ${String(total).padStart(6)}건 중 영업 ${String(open).padStart(5)} · 적재 ${String(saved).padStart(5)}${' '.repeat(10)}`)
}

console.log(`\n처리 ${stat.seen.toLocaleString()}건`)
console.log(`  적재    : ${stat.saved.toLocaleString()}`)
console.log(`  폐업 제외: ${stat.closed.toLocaleString()}`)
console.log(`  좌표 없음: ${stat.noCoord.toLocaleString()}`)
console.log(`  좌표 이상: ${stat.outside.toLocaleString()}`)

// 실제 업태 값을 보여준다. UI 필터 버튼이 이 값과 정확히 일치해야 필터가 동작한다.
console.log(`\n실제 업태(UPTAENM) 상위 15개 — UI 필터는 이 문자열과 일치해야 한다:`)
for (const [k, v] of [...categories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(v).padStart(6).toLocaleString()}  ${k}`)
}

if (!DRY) {
  const [c] = await sql`select count(*)::int as n from stores where source='seoul_opendata'`
  console.log(`\nstores(공공데이터): ${c.n.toLocaleString()}건`)
}
await sql.end()
