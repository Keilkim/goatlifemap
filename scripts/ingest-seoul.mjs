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
const guIndex = argv.indexOf('--gu')
const guArg = guIndex > -1 ? argv[guIndex + 1] : null
if (guIndex > -1 && (!guArg || guArg.startsWith('--'))) {
  console.error('--gu 뒤에는 서울 자치구 이름이 필요합니다.')
  process.exit(1)
}
const SOURCE = 'seoul_opendata'
const MIN_PREVIOUS_RATIO = 0.7

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
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
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

const categories = new Map()

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

async function createRun(scope) {
  if (DRY) return null
  const [run] = await sql`
    insert into ingestion_runs (source, scope, full_snapshot, status, stats)
    values (${SOURCE}, ${scope}, false, 'running', '{}'::jsonb)
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

async function previousFullCount(scope) {
  const [row] = await sql`
    select records_seen
    from ingestion_runs
    where source = ${SOURCE} and scope = ${scope}
      and status = 'completed' and full_snapshot
    order by completed_at desc nulls last, started_at desc
    limit 1
  `
  return row?.records_seen ?? null
}

async function scanDistrict(gu, stats) {
  const service = `LOCALDATA_072404_${gu.code}`
  const first = await fetchPage(service, 1, 1)
  const total = Number(first?.list_total_count)
  if (!Number.isInteger(total) || total <= 0) throw new Error(`${gu.name}: list_total_count가 1 이상이 아닙니다.`)

  const rawRows = []
  for (let start = 1; start <= total; start += PAGE) {
    const end = Math.min(start + PAGE - 1, total)
    const body = await fetchPage(service, start, end)
    if (Number(body?.list_total_count) !== total) {
      throw new Error(`${gu.name}: 페이지 total(${body?.list_total_count})이 최초 total(${total})과 다릅니다.`)
    }
    if (!Array.isArray(body?.row)) throw new Error(`${gu.name}: ${start}-${end} 페이지 row가 배열이 아닙니다.`)
    const expected = end - start + 1
    if (body.row.length !== expected) {
      throw new Error(`${gu.name}: ${start}-${end} 페이지가 ${expected}행 대신 ${body.row.length}행을 반환했습니다.`)
    }
    rawRows.push(...body.row)
    process.stdout.write(`\r  ${gu.name.padEnd(6)} ${String(end).padStart(6)}/${total} 네트워크 스캔   `)
  }
  if (rawRows.length !== total) {
    throw new Error(`${gu.name}: 전체 ${total}행 중 ${rawRows.length}행만 수신했습니다.`)
  }

  const ids = rawRows.map((r) => r.MGTNO?.trim() ?? '')
  if (ids.some((id) => !id)) throw new Error(`${gu.name}: 관리번호가 없는 행이 있습니다.`)
  if (new Set(ids).size !== ids.length) throw new Error(`${gu.name}: 중복 관리번호가 있습니다.`)

  const rows = []
  for (const r of rawRows) {
    const sourceStatus = r.DTLSTATENM?.trim()
    if (!sourceStatus) throw new Error(`${gu.name}: 상세영업상태가 없는 행(${r.MGTNO})이 있습니다.`)
    const sourceOpen = sourceStatus === '영업'
    const cat = r.UPTAENM?.trim() || null
    if (sourceOpen && cat) categories.set(cat, (categories.get(cat) ?? 0) + 1)

    let pt = null
    if (sourceOpen) {
      stats.open++
      const xr = r.X?.trim(), yr = r.Y?.trim()
      if (!xr || !yr) stats.noCoord++
      else {
        pt = convert(xr, yr)
        if (!pt) stats.outside++
      }
    } else {
      stats.closed++
    }
    const name = r.BPLCNM?.trim() || null
    if (sourceOpen && !name) stats.noName++
    const insertable = sourceOpen && !!name && !!pt
    if (insertable) stats.insertable++

    rows.push({
      license_no: r.MGTNO.trim(),
      name,
      road_address: r.RDNWHLADDR?.trim() || null,
      lot_address: r.SITEWHLADDR?.trim() || null,
      category: cat,
      district: gu.name,
      lat: pt?.lat ?? null,
      lng: pt?.lng ?? null,
      source_open: sourceOpen,
      source_status: sourceStatus,
      insertable,
    })
  }
  stats.recordsSeen = total
  return { rows, fullSnapshot: true }
}

async function applyDistrict(runId, gu, snapshot, stats) {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`ingest:${SOURCE}:${gu.name}`}))`
    await tx`
      select set_config('app.change_source', ${SOURCE}, true),
             set_config('app.ingestion_run_id', ${runId}, true)
    `
    await tx`
      create temporary table ingest_seoul_stores (
        license_no text primary key,
        name text,
        road_address text,
        lot_address text,
        category text,
        district text not null,
        lat double precision,
        lng double precision,
        source_open boolean not null,
        source_status text not null,
        insertable boolean not null
      ) on commit drop
    `
    for (let i = 0; i < snapshot.rows.length; i += 1000) {
      const chunk = snapshot.rows.slice(i, i + 1000)
      await tx`
        insert into ingest_seoul_stores ${tx(chunk,
          'license_no', 'name', 'road_address', 'lot_address', 'category', 'district',
          'lat', 'lng', 'source_open', 'source_status', 'insertable')}
      `
    }

    // 영업 중인 신규 가게와 메타데이터만 반영한다. 기존 is_open은 후보 승인 전까지 보존한다.
    await tx`
      insert into stores
        (license_no, name, road_address, lot_address, category, district, lat, lng, is_open, source)
      select license_no, name, road_address, lot_address, category, district, lat, lng, true, ${SOURCE}
      from ingest_seoul_stores
      where insertable
      on conflict (license_no) do update set
        name = excluded.name,
        road_address = excluded.road_address,
        lot_address = excluded.lot_address,
        category = excluded.category,
        district = excluded.district,
        lat = excluded.lat,
        lng = excluded.lng,
        updated_at = now()
      where stores.source = ${SOURCE}
        and (stores.name, stores.road_address, stores.lot_address, stores.category,
             stores.district, stores.lat, stores.lng)
          is distinct from
            (excluded.name, excluded.road_address, excluded.lot_address, excluded.category,
             excluded.district, excluded.lat, excluded.lng)
    `

    const reopenEvents = await tx`
      insert into data_change_events
        (entity_type, entity_id, store_id, event_type, status, summary,
         old_value, new_value, source, ingest_run_id, dedupe_key)
      select 'store', s.id, s.id, 'store_reopened', 'pending',
             format('서울시 공공데이터에서 가게 "%s" 영업 재등장 — 영업 재개 확인 필요', s.name),
             jsonb_build_object('is_open', s.is_open),
             jsonb_build_object('is_open', true, 'source_status', g.source_status),
             ${SOURCE}, ${runId}, ${SOURCE} || ':store:' || s.id::text || ':store_reopened'
      from ingest_seoul_stores g
      join stores s on s.license_no = g.license_no and s.source = ${SOURCE}
      where g.source_open and not s.is_open
        and not exists (
          select 1 from data_change_events rejected
          where rejected.dedupe_key = ${SOURCE} || ':store:' || s.id::text || ':store_reopened'
            and rejected.status = 'rejected' and rejected.actor = 'admin'
            and rejected.old_value = jsonb_build_object('is_open', s.is_open)
            and rejected.new_value = jsonb_build_object(
              'is_open', true, 'source_status', g.source_status
            )
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

    // 명시적 폐업 행과 완전한 구별 목록에서 사라진 기존 행을 같은 종료 후보로 모은다.
    const closeEvents = await tx`
      insert into data_change_events
        (entity_type, entity_id, store_id, event_type, status, summary,
         old_value, new_value, source, ingest_run_id, dedupe_key)
      select 'store', s.id, s.id, 'store_closed', 'pending',
             case when g.license_no is null
               then format('서울시 %s 전체 목록에서 가게 "%s" 미관측 — 영업 종료 확인 필요', ${gu.name}::text, s.name)
               else format('서울시 공공데이터의 가게 "%s" 상태가 "%s" — 영업 종료 확인 필요', s.name, g.source_status)
             end,
             jsonb_build_object('is_open', s.is_open),
             case when g.license_no is null
               then jsonb_build_object('is_open', false, 'reason', 'not_seen')
               else jsonb_build_object('is_open', false, 'reason', 'source_status', 'source_status', g.source_status)
             end,
             ${SOURCE}, ${runId}, ${SOURCE} || ':store:' || s.id::text || ':store_closed'
      from stores s
      left join ingest_seoul_stores g on g.license_no = s.license_no
      where s.source = ${SOURCE} and s.is_open
        and ((g.license_no is not null and not g.source_open)
          or (g.license_no is null and s.district = ${gu.name}))
        and not exists (
          select 1 from data_change_events rejected
          where rejected.dedupe_key = ${SOURCE} || ':store:' || s.id::text || ':store_closed'
            and rejected.status = 'rejected' and rejected.actor = 'admin'
            and rejected.old_value = jsonb_build_object('is_open', s.is_open)
            and rejected.new_value = case when g.license_no is null
              then jsonb_build_object('is_open', false, 'reason', 'not_seen')
              else jsonb_build_object(
                'is_open', false, 'reason', 'source_status', 'source_status', g.source_status
              )
            end
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

    // 후속 완전 스냅샷에서 원천 차이가 사라졌거나 현재값이 이미 목표 상태면 후보를 자동 철회한다.
    const staleEvents = await tx`
      update data_change_events e
      set status = 'rejected', reviewed_at = now(), actor = ${SOURCE},
          ingest_run_id = ${runId}, decision_note = '후속 관측에서 차이가 사라져 자동 철회'
      where e.source = ${SOURCE} and e.status in ('pending', 'held')
        and exists (
          select 1 from stores scoped
          where scoped.id = e.entity_id
            and (scoped.district = ${gu.name} or exists (
              select 1 from ingest_seoul_stores observed
              where observed.license_no = scoped.license_no
            ))
        )
        and (
          (e.event_type = 'store_closed' and (
            exists (select 1 from stores s where s.id = e.entity_id and not s.is_open)
            or exists (
              select 1 from stores s
              join ingest_seoul_stores observed on observed.license_no = s.license_no
              where s.id = e.entity_id and observed.source_open
            )
          ))
          or (e.event_type = 'store_reopened' and (
            exists (select 1 from stores s where s.id = e.entity_id and s.is_open)
            or exists (
              select 1 from stores s
              join ingest_seoul_stores observed on observed.license_no = s.license_no
              where s.id = e.entity_id and not observed.source_open
            )
            or exists (
              select 1 from stores s
              where s.id = e.entity_id and s.district = ${gu.name}
                and not exists (
                  select 1 from ingest_seoul_stores observed
                  where observed.license_no = s.license_no
                )
            )
          ))
        )
      returning id
    `

    const candidateStats = {
      storeReopened: reopenEvents.length,
      storeClosed: closeEvents.length,
      staleAutoRejected: staleEvents.length,
    }
    const [eventCount] = await tx`
      select count(*)::int as n from data_change_events where ingest_run_id = ${runId}
    `
    const completedStats = { ...stats, candidatesObserved: candidateStats }
    await tx`
      update ingestion_runs
      set status = 'completed', full_snapshot = true,
          records_seen = ${stats.recordsSeen}, changes_detected = ${eventCount.n},
          stats = ${tx.json(completedStats)},
          error_text = null, completed_at = now()
      where id = ${runId}
    `
  })
}

const totals = { seen: 0, insertable: 0, open: 0, closed: 0, noCoord: 0, outside: 0, noName: 0 }
console.log(`대상: ${targets.length}개 구${DRY ? ' (dry run — DB에 쓰지 않음)' : ''}\n`)

try {
  for (const gu of targets) {
    let runId = null
    const stats = { recordsSeen: 0, insertable: 0, open: 0, closed: 0, noCoord: 0, outside: 0, noName: 0 }
    try {
      runId = await createRun(gu.name)
      const snapshot = await scanDistrict(gu, stats)

      if (!DRY) {
        const previous = await previousFullCount(gu.name)
        if (previous != null && previous > 0 && stats.recordsSeen < previous * MIN_PREVIOUS_RATIO) {
          throw new Error(
            `${gu.name} 비정상 급락: 직전 완전 수집 ${previous}건의 70% 미만(${stats.recordsSeen}건). DB 반영을 중단합니다.`,
          )
        }
        await applyDistrict(runId, gu, snapshot, stats)
      }

      totals.seen += stats.recordsSeen
      totals.insertable += stats.insertable
      totals.open += stats.open
      totals.closed += stats.closed
      totals.noCoord += stats.noCoord
      totals.outside += stats.outside
      totals.noName += stats.noName
      console.log(`\r  ${gu.name.padEnd(6)} ${String(stats.recordsSeen).padStart(6)}건 중 영업 ${String(stats.open).padStart(5)} · 적재 가능 ${String(stats.insertable).padStart(5)}${' '.repeat(8)}`)
    } catch (error) {
      await failRun(runId, error, stats)
      throw error
    }
  }

  console.log(`\n처리 ${totals.seen.toLocaleString()}건${DRY ? ' (dry run — DB 변경 없음)' : ''}`)
  console.log(`  적재 가능: ${totals.insertable.toLocaleString()}`)
  console.log(`  영업 중  : ${totals.open.toLocaleString()}`)
  console.log(`  폐업 상태: ${totals.closed.toLocaleString()}`)
  console.log(`  좌표 없음: ${totals.noCoord.toLocaleString()}`)
  console.log(`  좌표 이상: ${totals.outside.toLocaleString()}`)
  console.log(`  이름 없음: ${totals.noName.toLocaleString()}`)

  // 실제 업태 값을 보여준다. UI 필터 버튼이 이 값과 정확히 일치해야 필터가 동작한다.
  console.log(`\n실제 업태(UPTAENM) 상위 15개 — UI 필터는 이 문자열과 일치해야 한다:`)
  for (const [k, v] of [...categories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(v).padStart(6).toLocaleString()}  ${k}`)
  }

  if (!DRY) {
    const [c] = await sql`select count(*)::int as n from stores where source = ${SOURCE}`
    console.log(`\nstores(공공데이터): ${c.n.toLocaleString()}건`)
  }
} catch (error) {
  console.error(`\n수집 실패: ${messageOf(error)}`)
  process.exitCode = 1
} finally {
  await sql.end()
}
