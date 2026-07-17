// 착한가격업소(행정안전부) → stores + menus 적재
//
// 이게 왜 중요한가:
//   서울시 인허가 공공데이터는 가게 96,872곳을 주지만 메뉴와 가격이 없다.
//   착한가격업소는 메뉴명과 가격을 가진 유일한 공공데이터다. 서울 음식업 1,281곳,
//   메뉴의 79%가 만원 이하, 중앙값 7,000원 — 정의상 저가 업소라 이 서비스 목적에 맞는다.
//   게다가 정부가 분기마다 갱신하며 가격을 검증한다.
//
// 법적 근거:
//   공공데이터포털의 같은 데이터셋(행정안전부_착한가격업소 현황)이 "이용허락범위 제한 없음"이다.
//   저작권법 93조 2항이 문제 삼는 "타인의 데이터베이스를 반복적·체계적으로 복제"에 해당하지
//   않는다 — 정부가 재사용하라고 공개한 데이터다.
//   그래도 정부 서버에 예의는 지킨다: 상세 조회 사이에 간격을 두고, 분기에 한 번만 돌린다.
//
// 왜 인허가 데이터와 매칭하지 않는가:
//   이름+좌표 100m로 대조해보니 6%만 매칭됐다. 우리 인허가 데이터는 '일반음식점'인데
//   착한가격업소에는 '휴게음식점'(분식/카페)이 섞여 있어서다. 억지 매칭은 엉뚱한 가게에
//   메뉴를 붙인다. 별도 가게로 넣되, 지도는 "메뉴 있는 가게"만 띄우므로 같은 식당의
//   인허가 레코드는 표시되지 않아 중복 마커가 생기지 않는다.
//
// 사용법:
//   node scripts/ingest-goodprice.mjs           # 서울 전역
//   node scripts/ingest-goodprice.mjs --dry     # DB에 쓰지 않고 집계만
//   node scripts/ingest-goodprice.mjs --limit 50

import postgres from 'postgres'
import { readFileSync } from 'node:fs'

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch { /* .env 없으면 환경변수 사용 */ }

const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/jumsim'
const BASE = 'https://www.goodprice.go.kr'
// HTTP 헤더는 ASCII만 허용된다 — 한글을 넣으면 ByteString 변환에서 터진다.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; jumsim-bang-eo/0.1; public open data)',
  Referer: `${BASE}/bssh/bsshList.do`,
}

const argv = process.argv
const DRY = argv.includes('--dry')
const LIMIT = argv.indexOf('--limit') > -1 ? parseInt(argv[argv.indexOf('--limit') + 1], 10) : Infinity

// 서울 대략 경계. bbox엔 경기 일부가 걸리므로 주소로 다시 거른다.
const SEOUL_BBOX = { swLat: 37.40, swLng: 126.75, neLat: 37.72, neLng: 127.19 }

// 착한가격업소 업종은 음식업 말고도 미용/이용/세탁/숙박이 섞여 있다. 음식만 남긴다.
const FOOD_PREFIX = ['한식', '중식', '일식', '양식', '경양식', '분식', '기타요식업', '치킨', '호프', '제과']
const isFood = (induty) => FOOD_PREFIX.some((p) => (induty ?? '').startsWith(p))

// 카페는 점심이 아니다.
//
// '기타요식업' 155곳 중 111곳(72%)이 커피숍이었다. 아메리카노 1,900원은 "만원 이하"이긴 해도
// "지금 이 동네에서 뭘 먹을까"의 답이 아니다. 지도가 커피로 덮이면 서비스가 망가진다.
//
// 그런데 업종으로 통째로 빼면 같은 '기타요식업'인 PHO358(소고기 쌀국수 7,000원)처럼
// 진짜 점심집도 날아간다. 그래서 업종이 아니라 메뉴로 판단한다 —
// 가게의 메뉴가 전부 음료면 넣지 않는다. 음료 하나라도 밥이 섞여 있으면 남긴다.
const DRINK_RE =
  /아메리카노|라떼|라테|에스프레소|카푸치노|커피|아이스티|에이드|스무디|주스|빙수|생과일|차\(|음료|녹차|홍차|버블티|쉐이크|셰이크|프라페|콜드브루|아메키라노|아메리카/

// 공공데이터에도 오타가 있다. 실제로 "카페라뗴"(떼가 아니라 뗴)라고 적힌 업소가 있었고,
// 그 한 글자 때문에 커피숍이 카페 필터를 통과해 점심 지도에 올라왔다.
// 자모가 어긋난 흔한 변형을 미리 접어둔다.
function normalize(s) {
  return (s ?? '')
    .replace(/뗴/g, '떼')
    .replace(/떼/g, '떼')
    .replace(/\s+/g, '')
}

function isDrink(name) {
  return DRINK_RE.test(normalize(name))
}

function isAllDrinks(menus) {
  return menus.length > 0 && menus.every((m) => isDrink(m.name))
}

// 업소명이 HTML 이중 이스케이프돼 온다: "보리&amp;amp;치킨" → "보리&치킨"
function unescapeTwice(s) {
  const once = (t) =>
    (t ?? '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#40;/g, '(').replace(/&#41;/g, ')')
  return once(once(s)).trim()
}

// 착한가격업소 업종("한식_면류")을 우리 필터 값(공공데이터 UPTAENM)에 맞춘다.
// 안 맞추면 '중식' 필터를 눌러도 착한가격업소 중국집이 안 나온다 — 실제로 겪은 버그다.
function mapCategory(induty) {
  const s = induty ?? ''
  if (s.startsWith('중식')) return '중국식'
  if (s.startsWith('일식')) return '일식'
  if (s.includes('분식')) return '분식'
  if (s.startsWith('양식') || s.startsWith('경양식')) return '경양식'
  if (s.startsWith('치킨') || s.startsWith('호프')) return '호프/통닭'
  if (s.startsWith('한식')) return '한식'
  return '기타'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function post(path, body, isForm = false) {
  const opts = { method: 'POST', headers: { ...HEADERS }, signal: AbortSignal.timeout(30000) }
  if (isForm) {
    const fd = new FormData()
    for (const [k, v] of Object.entries(body)) fd.append(k, String(v))
    opts.body = fd
  } else {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
    opts.body = new URLSearchParams(body).toString()
  }
  const res = await fetch(`${BASE}${path}`, opts)
  return res.json()
}

const sql = postgres(DB, { max: 4 })

// 1단계: 지도 데이터 1회 요청으로 서울 전역 업소 목록 + 좌표를 받는다.
// level=1이면 클러스터가 아니라 개별 지점(point)으로 온다.
console.log('착한가격업소 목록 조회 중…')
const list = await post('/bssh/selectMapData.json', { ...SEOUL_BBOX, level: 1 })
const all = list.items ?? []

const targets = all
  .filter((i) => (i.roadNmAddr ?? '').startsWith('서울'))
  .filter((i) => isFood(i.indutyNm))
  .filter((i) => Number.isFinite(parseFloat(i.lat)) && Number.isFinite(parseFloat(i.lot)))
  .slice(0, LIMIT)

console.log(`  전체 ${all.length}건 → 서울 음식업 ${targets.length}곳\n`)
if (!targets.length) {
  console.error('업소를 못 받았다. 엔드포인트나 파라미터가 바뀌었을 수 있다.')
  await sql.end()
  process.exit(1)
}

// 2단계: 업소별 상세로 메뉴 목록을 받는다. 목록 응답엔 대표 메뉴 1개뿐이다.
let storesSaved = 0, menusSaved = 0, failed = 0, noMenu = 0, cafes = 0

for (const [idx, it] of targets.entries()) {
  const name = unescapeTwice(it.bsshNm)
  const lat = parseFloat(it.lat), lng = parseFloat(it.lot)

  let menus = []
  try {
    const detail = await post('/bssh/bsshInfo.json', { bsshSn: it.bsshSn }, true)
    menus = (detail.menuList ?? [])
      .map((m) => ({ name: unescapeTwice(m.menuNm), price: parseInt(m.menuPc, 10) }))
      .filter((m) => m.name && Number.isInteger(m.price) && m.price > 0 && m.price <= 1_000_000)
  } catch {
    failed++
  }

  // 상세가 실패했거나 비었으면 목록에 있던 대표 메뉴라도 쓴다
  if (!menus.length && it.menuNm && parseInt(it.menuPc, 10) > 0) {
    menus = [{ name: unescapeTwice(it.menuNm), price: parseInt(it.menuPc, 10) }]
  }
  if (!menus.length) { noMenu++; continue }

  // 메뉴가 전부 음료면 카페다. 점심 지도에 넣지 않는다.
  if (isAllDrinks(menus)) { cafes++; continue }

  // 같은 업소 안에 같은 메뉴명이 두 번 오면 (store_id, name) unique에 걸린다.
  // ON CONFLICT는 한 문장 안의 중복 행을 처리하지 못하므로 미리 접는다.
  const uniq = [...new Map(menus.map((m) => [m.name, m])).values()]

  if (!DRY) {
    const [store] = await sql`
      insert into stores (license_no, name, road_address, category, district, lat, lng, is_open, source)
      values (
        ${'GOODPRICE-' + it.bsshSn}, ${name}, ${it.roadNmAddr?.trim() ?? null},
        ${mapCategory(it.indutyNm)},
        ${(it.roadNmAddr ?? '').match(/서울특별시\s+(\S+구)/)?.[1] ?? null},
        ${lat}, ${lng}, true, 'goodprice'
      )
      on conflict (license_no) do update set
        name = excluded.name, road_address = excluded.road_address,
        category = excluded.category, district = excluded.district,
        lat = excluded.lat, lng = excluded.lng, updated_at = now()
      returning id
    `

    const rows = uniq.map((m, i) => ({
      store_id: store.id, name: m.name, price: m.price, sort_order: i,
      is_available: true, source: 'official_menu', verified_at: new Date(),
    }))
    await sql`
      insert into menus ${sql(rows, 'store_id', 'name', 'price', 'sort_order', 'is_available', 'source', 'verified_at')}
      on conflict (store_id, name) do update set
        price = excluded.price, sort_order = excluded.sort_order,
        is_available = true, verified_at = now(), updated_at = now()
    `
    menusSaved += rows.length
  } else {
    menusSaved += uniq.length
  }
  storesSaved++

  if ((idx + 1) % 25 === 0 || idx === targets.length - 1) {
    process.stdout.write(`\r  ${idx + 1}/${targets.length} · 가게 ${storesSaved} · 메뉴 ${menusSaved}   `)
  }
  // 정부 서버에 예의를 지킨다. 분기에 한 번 도는 스크립트라 급할 이유가 없다.
  await sleep(120)
}

console.log(`\n\n완료${DRY ? ' (dry run)' : ''}`)
console.log(`  가게 : ${storesSaved}곳`)
console.log(`  메뉴 : ${menusSaved}개`)
console.log(`  카페 제외: ${cafes} · 상세 조회 실패: ${failed} · 메뉴 없음: ${noMenu}`)

if (!DRY) {
  const [s] = await sql`
    select
      (select count(*)::int from stores where source='goodprice') as stores,
      (select count(*)::int from menus where source='official_menu') as menus,
      (select count(*)::int from menus where source='official_menu' and price <= 10000) as under10k
  `
  console.log(`\nDB: 착한가격업소 ${s.stores}곳 · 공식 메뉴 ${s.menus}개 (만원 이하 ${s.under10k}개)`)
}
await sql.end()
