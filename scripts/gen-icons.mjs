// 메뉴 아이콘 생성 (OpenAI gpt-image-1.5)
//
// 왜 메뉴명 단위인가:
//   메뉴는 4,721개지만 고유 메뉴명은 2,151개고, 분포가 심하게 치우쳐 있다.
//   김치찌개 하나가 167곳, 된장찌개가 148곳에 있다. 상위 100개 메뉴명이 전체 메뉴의
//   46%를 덮는다. 행마다 만들면 100배를 낭비하는 셈이다.
//
// 왜 gpt-image-1.5인가:
//   최신 플래그십 gpt-image-2는 투명 배경을 지원하지 않는다 (공식 문서에 명시:
//   "gpt-image-2 doesn't currently support transparent backgrounds").
//   지도 위에 얹을 아이콘이라 배경이 뚫려 있어야 한다.
//
// 사용법:
//   node scripts/gen-icons.mjs --limit 3        # 3개만 (파이프라인 확인용)
//   node scripts/gen-icons.mjs --limit 100      # 상위 100개
//   node scripts/gen-icons.mjs --dry            # 목록만 보고 만들지 않음

import postgres from 'postgres'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch { /* .env 없으면 환경변수 사용 */ }

const KEY = process.env.OPENAI_API_KEY
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/jumsim'
const argv = process.argv
const DRY = argv.includes('--dry')
const LIMIT = argv.indexOf('--limit') > -1 ? parseInt(argv[argv.indexOf('--limit') + 1], 10) : 100
/** 동시 생성 수. 정중하게, 그리고 rate limit에 걸리지 않게. */
const CONCURRENCY = 4
/** 지도에서 30px로 보여준다. 1024px 원본을 그대로 두면 100장에 150MB다. */
const ICON_PX = 96

if (!KEY && !DRY) {
  console.error('OPENAI_API_KEY가 없습니다 (.env)')
  process.exit(1)
}

const OUT = new URL('../public/icons/', import.meta.url).pathname
if (!DRY) mkdirSync(OUT, { recursive: true })

const sql = postgres(DB, { max: 4 })

/** 파일명으로 쓸 수 있게. 한글은 그대로 두면 URL에서 인코딩이 지저분해진다. */
function slug(name) {
  return Buffer.from(name).toString('base64url').slice(0, 40)
}

// 음식 사진이 아니라 아이콘을 원한다. 지도 위 30px에서 알아볼 수 있으려면
// 디테일이 아니라 실루엣과 색으로 구분돼야 한다.
function prompt(name) {
  return [
    `A minimal flat vector food icon representing the Korean dish "${name}".`,
    'Single centered object, bold simple shapes, thick clean outlines, flat colors with minimal shading.',
    'Designed to be legible at 32 pixels: strong silhouette, high contrast, no fine detail.',
    'Top-down or 3/4 view of the dish in its typical serving vessel.',
    'No text, no letters, no numbers, no watermark, no plate shadow, no background scenery.',
    'Fully transparent background.',
  ].join(' ')
}

async function generate(name) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'gpt-image-1.5',
      prompt: prompt(name),
      size: '1024x1024',
      // 30px로 줄여 쓸 아이콘이라 high로 뽑을 이유가 없다. 비용이 20배 차이난다.
      quality: 'low',
      background: 'transparent',
      output_format: 'png',
      n: 1,
    }),
    signal: AbortSignal.timeout(120000),
  })
  const d = await res.json()
  if (d.error) throw new Error(d.error.message ?? JSON.stringify(d.error))
  const b64 = d.data?.[0]?.b64_json
  if (!b64) throw new Error('이미지가 없다')
  return { buf: Buffer.from(b64, 'base64'), tokens: d.usage?.output_tokens ?? 0 }
}

// 상위 메뉴명. 많이 쓰이는 것부터 만들어야 한 장이 여러 가게를 덮는다.
const rows = await sql`
  select name, count(*)::int as n
  from menus
  where is_available
  group by name
  order by count(*) desc
  limit ${LIMIT}
`

const covered = rows.reduce((s, r) => s + r.n, 0)
const [{ total }] = await sql`select count(*)::int as total from menus where is_available`
console.log(`상위 ${rows.length}개 메뉴명 → 메뉴 ${covered}/${total}개 (${(covered / total * 100).toFixed(1)}%) 커버\n`)

if (DRY) {
  rows.slice(0, 20).forEach((r) => console.log(`  ${r.name} — ${r.n}곳`))
  await sql.end()
  process.exit(0)
}

let done = 0, failed = 0, skipped = 0, tokens = 0
const queue = [...rows]

async function worker() {
  for (;;) {
    const row = queue.shift()
    if (!row) return
    const file = `${slug(row.name)}.png`
    const path = OUT + file

    // 이미 있으면 다시 만들지 않는다. 돈이 드는 작업이라 재실행이 안전해야 한다.
    if (existsSync(path)) {
      skipped++
    } else {
      try {
        const { buf, tokens: t } = await generate(row.name)
        writeFileSync(path, buf)
        // 지도에서 30px로 쓴다. 1024px 원본은 장당 1.5MB라 그대로 두면 안 된다.
        execFileSync('sips', ['-Z', String(ICON_PX), path, '--out', path], { stdio: 'ignore' })
        tokens += t
        done++
      } catch (e) {
        failed++
        console.log(`\n  실패: ${row.name} — ${String(e.message).slice(0, 80)}`)
        continue
      }
    }

    // 이 메뉴명을 가진 모든 가게의 메뉴에 붙인다 — 이게 한 장으로 여러 곳을 덮는 지점이다
    await sql`
      update menus set image_url = ${'/icons/' + file}, updated_at = now()
      where name = ${row.name} and image_url is null
    `
    process.stdout.write(`\r  ${done + skipped + failed}/${rows.length} · 생성 ${done} · 재사용 ${skipped} · 실패 ${failed}   `)
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))

const [stat] = await sql`
  select
    count(*) filter (where image_url is not null)::int as with_icon,
    count(*)::int as all_menus
  from menus where is_available
`
console.log(`\n\n완료`)
console.log(`  생성 ${done}장 · 재사용 ${skipped}장 · 실패 ${failed}장`)
console.log(`  이미지 토큰 ${tokens.toLocaleString()}`)
console.log(`  아이콘 붙은 메뉴: ${stat.with_icon}/${stat.all_menus} (${(stat.with_icon / stat.all_menus * 100).toFixed(1)}%)`)
await sql.end()
