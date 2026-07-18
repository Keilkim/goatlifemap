// 착한가격업소(행정안전부) → stores + menus 적재
//
// 이게 왜 중요한가:
//   서울시 인허가 공공데이터는 가게 96,872곳을 주지만 메뉴와 가격이 없다.
//   착한가격업소는 메뉴명과 가격을 가진 유일한 공공데이터다. 서울 음식업 1,281곳,
//   메뉴의 79%가 만원 이하, 중앙값 7,000원 — 정의상 저가 업소라 이 서비스 목적에 맞는다.
//   게다가 정부가 분기마다 갱신하며 가격을 검증한다.
//
// 이용조건:
//   공공데이터포털의 같은 데이터셋(행정안전부_착한가격업소 현황)은 현재
//   "이용허락범위 제한 없음"으로 안내된다. 운영 전에는 최신 이용조건과 제공 방식을 다시
//   확인한다. 제공 서버 부하를 줄이려고 상세 조회 사이에 간격을 둔다.
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
const limitIndex = argv.indexOf('--limit')
const LIMIT = limitIndex > -1 ? parseInt(argv[limitIndex + 1], 10) : Infinity
if (limitIndex > -1 && (!Number.isInteger(LIMIT) || LIMIT <= 0)) {
  console.error('--limit 뒤에는 1 이상의 정수가 필요합니다.')
  process.exit(1)
}
const LIMITED = Number.isFinite(LIMIT)
const SOURCE = 'goodprice'
const SCOPE = 'seoul'
const MIN_PREVIOUS_RATIO = 0.7

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
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json()
}

const sql = postgres(DB, { max: 4 })

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

async function createRun() {
  if (DRY) return null
  const [run] = await sql`
    insert into ingestion_runs (source, scope, full_snapshot, status, stats)
    values (${SOURCE}, ${SCOPE}, false, 'running', ${sql.json({ limited: LIMITED, limit: LIMITED ? LIMIT : null })})
    returning id
  `
  return run.id
}

async function failRun(runId, error, stats) {
  if (!runId) return
  try {
    await sql`
      update ingestion_runs
      set status = 'failed', full_snapshot = false,
          records_seen = ${stats.recordsSeen ?? 0},
          stats = ${sql.json(stats)},
          error_text = ${messageOf(error).slice(0, 4000)}, completed_at = now()
      where id = ${runId} and status = 'running'
    `
  } catch (recordError) {
    console.error(`수집 실패 기록도 남기지 못했습니다: ${messageOf(recordError)}`)
  }
}

async function previousFullStats() {
  const [row] = await sql`
    select records_seen,
           case when jsonb_typeof(stats) = 'object' then (stats ->> 'menusSeen')::int end as menus_seen
    from ingestion_runs
    where source = ${SOURCE} and scope = ${SCOPE}
      and status = 'completed' and full_snapshot
    order by completed_at desc nulls last, started_at desc
    limit 1
  `
  if (!row) return null
  return { recordsSeen: row.records_seen, menusSeen: row.menus_seen ?? null }
}

async function scanGoodprice(stats) {
  // 목록을 전부 받은 뒤에만 상세를 돈다. 수집 중에는 운영 테이블을 전혀 건드리지 않는다.
  console.log('착한가격업소 목록 조회 중…')
  const list = await post('/bssh/selectMapData.json', { ...SEOUL_BBOX, level: 1 })
  if (!Array.isArray(list?.items)) throw new Error('목록 응답의 items가 배열이 아닙니다.')
  const all = list.items

  const fullTargets = all
    .filter((i) => (i.roadNmAddr ?? '').startsWith('서울'))
    .filter((i) => isFood(i.indutyNm))
    .filter((i) => Number.isFinite(parseFloat(i.lat)) && Number.isFinite(parseFloat(i.lot)))

  if (!fullTargets.length) throw new Error('서울 음식업소를 한 곳도 받지 못했습니다.')
  const externalIds = fullTargets.map((i) => String(i.bsshSn ?? '').trim())
  if (externalIds.some((id) => !id)) throw new Error('업소 고유번호가 없는 목록 행이 있습니다.')
  if (new Set(externalIds).size !== externalIds.length) throw new Error('목록에 중복 업소 고유번호가 있습니다.')

  const targets = fullTargets.slice(0, LIMIT)
  stats.rawListCount = all.length
  stats.fullTargetCount = fullTargets.length
  stats.recordsSeen = targets.length
  console.log(`  전체 ${all.length}건 → 서울 음식업 ${fullTargets.length}곳${LIMITED ? ` → 제한 ${targets.length}곳` : ''}\n`)

  const stores = []
  const menus = []
  for (const [idx, it] of targets.entries()) {
    const licenseNo = `GOODPRICE-${String(it.bsshSn).trim()}`
    const storeName = unescapeTwice(it.bsshNm)
    if (!storeName) throw new Error(`업소명이 없는 행(${it.bsshSn})이 있습니다.`)
    let observedMenus = []
    let detailComplete = false

    try {
      const detail = await post('/bssh/bsshInfo.json', { bsshSn: it.bsshSn }, true)
      if (!Array.isArray(detail?.menuList)) throw new Error('상세 menuList가 배열이 아님')
      detailComplete = true
      observedMenus = detail.menuList
        .map((m) => ({ name: unescapeTwice(m.menuNm), price: parseInt(m.menuPc, 10) }))
        .filter((m) => m.name && Number.isInteger(m.price) && m.price > 0 && m.price <= 1_000_000)
    } catch {
      stats.detailFailures++
    }

    // 상세 실패 가게는 대표 메뉴를 신규/동일값 갱신에만 쓴다. 이 가게의 누락 메뉴 판정은 금지한다.
    const representativeName = unescapeTwice(it.menuNm)
    const representativePrice = parseInt(it.menuPc, 10)
    if (!observedMenus.length && representativeName
      && Number.isInteger(representativePrice) && representativePrice > 0 && representativePrice <= 1_000_000) {
      observedMenus = [{ name: representativeName, price: representativePrice }]
      stats.representativeFallbacks++
    }

    const allDrinks = isAllDrinks(observedMenus)
    if (!observedMenus.length) stats.noMenu++
    if (allDrinks) stats.cafes++
    const eligibleMenus = allDrinks
      ? []
      : [...new Map(observedMenus.map((m) => [m.name, m])).values()]

    stores.push({
      license_no: licenseNo,
      name: storeName,
      road_address: it.roadNmAddr?.trim() ?? null,
      category: mapCategory(it.indutyNm),
      district: (it.roadNmAddr ?? '').match(/서울특별시\s+(\S+구)/)?.[1] ?? null,
      lat: parseFloat(it.lat),
      lng: parseFloat(it.lot),
      detail_complete: detailComplete,
      should_upsert: eligibleMenus.length > 0,
    })
    for (const [sortOrder, menu] of eligibleMenus.entries()) {
      menus.push({ license_no: licenseNo, name: menu.name, price: menu.price, sort_order: sortOrder })
    }

    if ((idx + 1) % 25 === 0 || idx === targets.length - 1) {
      process.stdout.write(`\r  ${idx + 1}/${targets.length} · 메뉴 ${menus.length} · 상세 실패 ${stats.detailFailures}   `)
    }
    await sleep(120)
  }

  stats.storesEligible = stores.filter((s) => s.should_upsert).length
  stats.menusSeen = menus.length
  const fullSnapshot = !LIMITED && stats.detailFailures === 0
  return { stores, menus, fullSnapshot }
}

async function applySnapshot(runId, snapshot, stats) {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`ingest:${SOURCE}:${SCOPE}`}))`
    await tx`
      select set_config('app.change_source', ${SOURCE}, true),
             set_config('app.ingestion_run_id', ${runId}, true)
    `
    await tx`
      create temporary table ingest_goodprice_stores (
        license_no text primary key,
        name text not null,
        road_address text,
        category text,
        district text,
        lat double precision not null,
        lng double precision not null,
        detail_complete boolean not null,
        should_upsert boolean not null
      ) on commit drop
    `
    await tx`
      create temporary table ingest_goodprice_menus (
        license_no text not null,
        name text not null,
        price integer not null,
        sort_order integer not null,
        primary key (license_no, name)
      ) on commit drop
    `

    for (let i = 0; i < snapshot.stores.length; i += 1000) {
      const chunk = snapshot.stores.slice(i, i + 1000)
      await tx`
        insert into ingest_goodprice_stores ${tx(chunk,
          'license_no', 'name', 'road_address', 'category', 'district', 'lat', 'lng',
          'detail_complete', 'should_upsert')}
      `
    }
    for (let i = 0; i < snapshot.menus.length; i += 1000) {
      const chunk = snapshot.menus.slice(i, i + 1000)
      await tx`
        insert into ingest_goodprice_menus ${tx(chunk, 'license_no', 'name', 'price', 'sort_order')}
      `
    }

    // 신규 가게와 메타데이터만 반영한다. 기존 is_open은 수집기가 직접 바꾸지 않는다.
    await tx`
      insert into stores
        (license_no, name, road_address, category, district, lat, lng, is_open, source)
      select license_no, name, road_address, category, district, lat, lng, true, ${SOURCE}
      from ingest_goodprice_stores
      where should_upsert
      on conflict (license_no) do update set
        name = excluded.name,
        road_address = excluded.road_address,
        category = excluded.category,
        district = excluded.district,
        lat = excluded.lat,
        lng = excluded.lng,
        updated_at = now()
      where stores.source = ${SOURCE}
        and (stores.name, stores.road_address, stores.category, stores.district, stores.lat, stores.lng)
          is distinct from
            (excluded.name, excluded.road_address, excluded.category, excluded.district, excluded.lat, excluded.lng)
    `

    const reopenEvents = await tx`
      insert into data_change_events
        (entity_type, entity_id, store_id, event_type, status, summary,
         old_value, new_value, source, ingest_run_id, dedupe_key)
      select 'store', s.id, s.id, 'store_reopened', 'pending',
             format('착한가격업소 목록에서 가게 "%s" 재등장 — 영업 재개 확인 필요', s.name),
             jsonb_build_object('is_open', s.is_open), jsonb_build_object('is_open', true),
             ${SOURCE}, ${runId}, ${SOURCE} || ':store:' || s.id::text || ':store_reopened'
      from stores s
      join ingest_goodprice_stores g on g.license_no = s.license_no
      where s.source = ${SOURCE} and not s.is_open
        and not exists (
          select 1 from data_change_events rejected
          where rejected.dedupe_key = ${SOURCE} || ':store:' || s.id::text || ':store_reopened'
            and rejected.status = 'rejected' and rejected.actor = 'admin'
            and rejected.old_value = jsonb_build_object('is_open', s.is_open)
            and rejected.new_value = jsonb_build_object('is_open', true)
        )
      on conflict (dedupe_key)
        where dedupe_key is not null and status in ('pending', 'held')
      do update set
        status = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.status else 'pending' end,
        summary = excluded.summary, old_value = excluded.old_value, new_value = excluded.new_value,
        ingest_run_id = excluded.ingest_run_id,
        detected_at = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.detected_at else now() end,
        reviewed_at = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.reviewed_at else null end,
        actor = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.actor else null end,
        decision_note = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.decision_note else null end
      returning id
    `

    let closeEvents = []
    if (snapshot.fullSnapshot) {
      closeEvents = await tx`
        insert into data_change_events
          (entity_type, entity_id, store_id, event_type, status, summary,
           old_value, new_value, source, ingest_run_id, dedupe_key)
        select 'store', s.id, s.id, 'store_closed', 'pending',
               format('착한가격업소 전체 목록에서 가게 "%s" 미관측 — 영업 종료 확인 필요', s.name),
               jsonb_build_object('is_open', s.is_open), jsonb_build_object('is_open', false),
               ${SOURCE}, ${runId}, ${SOURCE} || ':store:' || s.id::text || ':store_closed'
        from stores s
        where s.source = ${SOURCE} and s.is_open
          and not exists (
            select 1 from ingest_goodprice_stores g where g.license_no = s.license_no
          )
          and not exists (
            select 1 from data_change_events rejected
            where rejected.dedupe_key = ${SOURCE} || ':store:' || s.id::text || ':store_closed'
              and rejected.status = 'rejected' and rejected.actor = 'admin'
              and rejected.old_value = jsonb_build_object('is_open', s.is_open)
              and rejected.new_value = jsonb_build_object('is_open', false)
          )
        on conflict (dedupe_key)
          where dedupe_key is not null and status in ('pending', 'held')
        do update set
          status = case
            when data_change_events.old_value is not distinct from excluded.old_value
              and data_change_events.new_value is not distinct from excluded.new_value
            then data_change_events.status else 'pending' end,
          summary = excluded.summary, old_value = excluded.old_value, new_value = excluded.new_value,
          ingest_run_id = excluded.ingest_run_id,
          detected_at = case
            when data_change_events.old_value is not distinct from excluded.old_value
              and data_change_events.new_value is not distinct from excluded.new_value
            then data_change_events.detected_at else now() end,
          reviewed_at = case
            when data_change_events.old_value is not distinct from excluded.old_value
              and data_change_events.new_value is not distinct from excluded.new_value
            then data_change_events.reviewed_at else null end,
          actor = case
            when data_change_events.old_value is not distinct from excluded.old_value
              and data_change_events.new_value is not distinct from excluded.new_value
            then data_change_events.actor else null end,
          decision_note = case
            when data_change_events.old_value is not distinct from excluded.old_value
              and data_change_events.new_value is not distinct from excluded.new_value
            then data_change_events.decision_note else null end
        returning id
      `
    }

    // 신규 메뉴·정렬·동일한 현재 가격의 확인시각만 반영한다. 가격/판매상태 차이는 아래 후보로 남긴다.
    await tx`
      insert into menus
        (store_id, name, price, sort_order, is_available, source, verified_at)
      select s.id, g.name, g.price, g.sort_order, true, 'official_menu', now()
      from ingest_goodprice_menus g
      join stores s on s.license_no = g.license_no and s.source = ${SOURCE}
      on conflict (store_id, name) do update set
        sort_order = excluded.sort_order,
        verified_at = case
          when menus.price = excluded.price and menus.is_available then now()
          else menus.verified_at
        end,
        updated_at = case
          when menus.sort_order is distinct from excluded.sort_order
            or (menus.price = excluded.price and menus.is_available)
          then now() else menus.updated_at
        end
    `

    const priceEvents = await tx`
      insert into data_change_events
        (entity_type, entity_id, store_id, menu_id, event_type, status, summary,
         old_value, new_value, source, ingest_run_id, dedupe_key)
      select 'menu', m.id, m.store_id, m.id, 'menu_price_changed', 'pending',
             format('메뉴 "%s" 공식 가격 차이: %s원 → %s원', m.name,
               to_char(m.price, 'FM999,999,999'), to_char(g.price, 'FM999,999,999')),
             jsonb_build_object('price', m.price), jsonb_build_object('price', g.price),
             ${SOURCE}, ${runId}, ${SOURCE} || ':menu:' || m.id::text || ':menu_price_changed'
      from ingest_goodprice_menus g
      join stores s on s.license_no = g.license_no and s.source = ${SOURCE}
      join menus m on m.store_id = s.id and m.name = g.name
      where m.price is distinct from g.price
        and not exists (
          select 1 from data_change_events rejected
          where rejected.dedupe_key = ${SOURCE} || ':menu:' || m.id::text || ':menu_price_changed'
            and rejected.status = 'rejected' and rejected.actor = 'admin'
            and rejected.old_value = jsonb_build_object('price', m.price)
            and rejected.new_value = jsonb_build_object('price', g.price)
        )
      on conflict (dedupe_key)
        where dedupe_key is not null and status in ('pending', 'held')
      do update set
        status = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.status else 'pending' end,
        summary = excluded.summary, old_value = excluded.old_value, new_value = excluded.new_value,
        ingest_run_id = excluded.ingest_run_id,
        detected_at = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.detected_at else now() end,
        reviewed_at = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.reviewed_at else null end,
        actor = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.actor else null end,
        decision_note = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.decision_note else null end
      returning id
    `

    const restoredEvents = await tx`
      insert into data_change_events
        (entity_type, entity_id, store_id, menu_id, event_type, status, summary,
         old_value, new_value, source, ingest_run_id, dedupe_key)
      select 'menu', m.id, m.store_id, m.id, 'menu_restored', 'pending',
             format('공식 목록에 메뉴 "%s" 재등장 — 판매 재개 확인 필요', m.name),
             jsonb_build_object('is_available', m.is_available),
             jsonb_build_object('is_available', true),
             ${SOURCE}, ${runId}, ${SOURCE} || ':menu:' || m.id::text || ':menu_restored'
      from ingest_goodprice_menus g
      join stores s on s.license_no = g.license_no and s.source = ${SOURCE}
      join menus m on m.store_id = s.id and m.name = g.name
      where not m.is_available
        and not exists (
          select 1 from data_change_events rejected
          where rejected.dedupe_key = ${SOURCE} || ':menu:' || m.id::text || ':menu_restored'
            and rejected.status = 'rejected' and rejected.actor = 'admin'
            and rejected.old_value = jsonb_build_object('is_available', m.is_available)
            and rejected.new_value = jsonb_build_object('is_available', true)
        )
      on conflict (dedupe_key)
        where dedupe_key is not null and status in ('pending', 'held')
      do update set
        status = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.status else 'pending' end,
        summary = excluded.summary, old_value = excluded.old_value, new_value = excluded.new_value,
        ingest_run_id = excluded.ingest_run_id,
        detected_at = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.detected_at else now() end,
        reviewed_at = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.reviewed_at else null end,
        actor = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.actor else null end,
        decision_note = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.decision_note else null end
      returning id
    `

    // 메뉴 누락은 상세 목록이 정상적으로 완성된 가게 안에서만 판단한다.
    const removedEvents = await tx`
      insert into data_change_events
        (entity_type, entity_id, store_id, menu_id, event_type, status, summary,
         old_value, new_value, source, ingest_run_id, dedupe_key)
      select 'menu', m.id, m.store_id, m.id, 'menu_removed', 'pending',
             format('가게 "%s" 공식 상세에서 메뉴 "%s" 미관측 — 판매 종료 확인 필요', s.name, m.name),
             jsonb_build_object('is_available', m.is_available),
             jsonb_build_object('is_available', false),
             ${SOURCE}, ${runId}, ${SOURCE} || ':menu:' || m.id::text || ':menu_removed'
      from ingest_goodprice_stores g
      join stores s on s.license_no = g.license_no and s.source = ${SOURCE}
      join menus m on m.store_id = s.id and m.source = 'official_menu'
      where g.detail_complete and m.is_available
        and not exists (
          select 1 from ingest_goodprice_menus observed
          where observed.license_no = g.license_no and observed.name = m.name
        )
        and not exists (
          select 1 from data_change_events rejected
          where rejected.dedupe_key = ${SOURCE} || ':menu:' || m.id::text || ':menu_removed'
            and rejected.status = 'rejected' and rejected.actor = 'admin'
            and rejected.old_value = jsonb_build_object('is_available', m.is_available)
            and rejected.new_value = jsonb_build_object('is_available', false)
        )
      on conflict (dedupe_key)
        where dedupe_key is not null and status in ('pending', 'held')
      do update set
        status = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.status else 'pending' end,
        summary = excluded.summary, old_value = excluded.old_value, new_value = excluded.new_value,
        ingest_run_id = excluded.ingest_run_id,
        detected_at = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.detected_at else now() end,
        reviewed_at = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.reviewed_at else null end,
        actor = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.actor else null end,
        decision_note = case
          when data_change_events.old_value is not distinct from excluded.old_value
            and data_change_events.new_value is not distinct from excluded.new_value
          then data_change_events.decision_note else null end
      returning id
    `

    // 원천 차이가 사라졌거나 다른 경로에서 이미 같은 상태가 된 후보는 승인할 수 없게 자동 해제한다.
    const staleEvents = await tx`
      update data_change_events e
      set status = 'rejected', reviewed_at = now(), actor = ${SOURCE},
          ingest_run_id = ${runId}, decision_note = '후속 관측에서 차이가 사라져 자동 철회'
      where e.source = ${SOURCE} and e.status in ('pending', 'held')
        and (
          (e.event_type = 'store_closed' and (
            exists (select 1 from stores s where s.id = e.entity_id and not s.is_open)
            or exists (
              select 1 from stores s
              join ingest_goodprice_stores g on g.license_no = s.license_no
              where s.id = e.entity_id
            )
          ))
          or (e.event_type = 'store_reopened' and (
            exists (select 1 from stores s where s.id = e.entity_id and s.is_open)
            or (${snapshot.fullSnapshot} and exists (
              select 1 from stores s
              where s.id = e.entity_id
                and not exists (
                  select 1 from ingest_goodprice_stores g where g.license_no = s.license_no
                )
            ))
          ))
          or (e.event_type = 'menu_price_changed' and (
            exists (
              select 1 from menus m
              join stores s on s.id = m.store_id
              join ingest_goodprice_menus g on g.license_no = s.license_no and g.name = m.name
              where m.id = e.entity_id and m.price = g.price
            )
            or exists (
              select 1 from menus m
              join stores s on s.id = m.store_id
              join ingest_goodprice_stores g on g.license_no = s.license_no and g.detail_complete
              where m.id = e.entity_id
                and not exists (
                  select 1 from ingest_goodprice_menus observed
                  where observed.license_no = g.license_no and observed.name = m.name
                )
            )
            or (${snapshot.fullSnapshot} and exists (
              select 1 from menus m
              join stores s on s.id = m.store_id
              where m.id = e.entity_id
                and not exists (
                  select 1 from ingest_goodprice_stores observed
                  where observed.license_no = s.license_no
                )
            ))
          ))
          or (e.event_type = 'menu_removed' and (
            exists (select 1 from menus m where m.id = e.entity_id and not m.is_available)
            or exists (
              select 1 from menus m
              join stores s on s.id = m.store_id
              join ingest_goodprice_menus g on g.license_no = s.license_no and g.name = m.name
              where m.id = e.entity_id
            )
          ))
          or (e.event_type = 'menu_restored' and (
            exists (select 1 from menus m where m.id = e.entity_id and m.is_available)
            or exists (
              select 1 from menus m
              join stores s on s.id = m.store_id
              join ingest_goodprice_stores g on g.license_no = s.license_no and g.detail_complete
              where m.id = e.entity_id
                and not exists (
                  select 1 from ingest_goodprice_menus observed
                  where observed.license_no = g.license_no and observed.name = m.name
                )
            )
            or (${snapshot.fullSnapshot} and exists (
              select 1 from menus m
              join stores s on s.id = m.store_id
              where m.id = e.entity_id
                and not exists (
                  select 1 from ingest_goodprice_stores observed
                  where observed.license_no = s.license_no
                )
            ))
          ))
        )
      returning id
    `

    const candidateStats = {
      storeReopened: reopenEvents.length,
      storeClosed: closeEvents.length,
      menuPriceChanged: priceEvents.length,
      menuRestored: restoredEvents.length,
      menuRemoved: removedEvents.length,
      staleAutoRejected: staleEvents.length,
    }
    const [eventCount] = await tx`
      select count(*)::int as n from data_change_events where ingest_run_id = ${runId}
    `
    const completedStats = { ...stats, candidatesObserved: candidateStats }
    await tx`
      update ingestion_runs
      set status = 'completed', full_snapshot = ${snapshot.fullSnapshot},
          records_seen = ${stats.recordsSeen}, changes_detected = ${eventCount.n},
          stats = ${tx.json(completedStats)},
          error_text = null, completed_at = now()
      where id = ${runId}
    `
  })
}

let runId = null
const stats = {
  recordsSeen: 0,
  rawListCount: 0,
  fullTargetCount: 0,
  storesEligible: 0,
  menusSeen: 0,
  detailFailures: 0,
  representativeFallbacks: 0,
  noMenu: 0,
  cafes: 0,
  limited: LIMITED,
  limit: LIMITED ? LIMIT : null,
}

try {
  runId = await createRun()
  const snapshot = await scanGoodprice(stats)

  if (DRY) {
    console.log('\n\n완료 (dry run — DB 변경 없음)')
  } else {
    if (snapshot.fullSnapshot) {
      const previous = await previousFullStats()
      if (previous?.recordsSeen > 0 && stats.recordsSeen < previous.recordsSeen * MIN_PREVIOUS_RATIO) {
        throw new Error(
          `비정상 급락: 직전 완전 수집 ${previous.recordsSeen}곳의 70% 미만(${stats.recordsSeen}곳). DB 반영을 중단합니다.`,
        )
      }
      if (previous?.menusSeen > 0 && stats.menusSeen < previous.menusSeen * MIN_PREVIOUS_RATIO) {
        throw new Error(
          `비정상 메뉴 급락: 직전 완전 수집 ${previous.menusSeen}개의 70% 미만(${stats.menusSeen}개). DB 반영을 중단합니다.`,
        )
      }
    }
    await applySnapshot(runId, snapshot, stats)
    console.log(`\n\n완료${snapshot.fullSnapshot ? ' (완전 스냅샷)' : ' (부분 스냅샷 — 전역 누락 비교 안 함)'}`)
  }

  console.log(`  대상 가게: ${stats.recordsSeen}곳 · 적재 가능 ${stats.storesEligible}곳`)
  console.log(`  관측 메뉴: ${stats.menusSeen}개`)
  console.log(`  카페 제외: ${stats.cafes} · 상세 실패: ${stats.detailFailures} · 메뉴 없음: ${stats.noMenu}`)

  if (!DRY) {
    const [s] = await sql`
      select
        (select count(*)::int from stores where source = ${SOURCE}) as stores,
        (select count(*)::int from menus where source = 'official_menu') as menus,
        (select count(*)::int from menus where source = 'official_menu' and price <= 10000) as under10k
    `
    console.log(`\nDB: 착한가격업소 ${s.stores}곳 · 공식 메뉴 ${s.menus}개 (만원 이하 ${s.under10k}개)`)
  }
} catch (error) {
  await failRun(runId, error, stats)
  console.error(`\n수집 실패: ${messageOf(error)}`)
  process.exitCode = 1
} finally {
  await sql.end()
}
