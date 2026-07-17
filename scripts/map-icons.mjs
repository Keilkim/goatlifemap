// 아이콘 돌려쓰기.
//
// 고유 메뉴명은 2,151개지만 대부분 몇 개의 핵심 재료에서 파생된 이름이다:
//   김치찌게(오타)·김치찌개백반 → 김치찌개
//   소고기김밥·김치김밥·조김밥 → 김밥
//   등심돈까스·생선까스 → 돈까스
//   양푼비빔밥·돌솥비빔밥 → 비빔밥
// 이미 만든 96장으로 이들을 전부 덮을 수 있다. 새로 만들 이유가 없다.
//
// 방법: 메뉴명에서 핵심 요리를 찾아, 그 요리의 아이콘이 이미 있으면 붙인다.
// 긴 키워드부터 맞춰야 "김치찌개"가 "김밥"보다 먼저 걸린다.
//
// 사용법:
//   node scripts/map-icons.mjs --dry     # 뭐가 어디에 붙는지 보기만
//   node scripts/map-icons.mjs

import postgres from 'postgres'
import { readFileSync } from 'node:fs'

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch { /* .env 없으면 환경변수 사용 */ }

const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/jumsim'
const DRY = process.argv.includes('--dry')
const sql = postgres(DB, { max: 4 })

/** 흔한 오타·표기 흔들림을 접는다. 공공데이터엔 오타가 그대로 들어있다. */
function normalize(name) {
  return name
    .replace(/찌게/g, '찌개')   // 김치찌게 → 김치찌개
    .replace(/까스/g, '까스').replace(/가스/g, '까스')  // 돈가스·생선까스 → 한쪽으로
    .replace(/카츠/g, '까스')   // 돈카츠 → 돈까스
    .replace(/짜장/g, '자장')   // 짜장면 ↔ 자장면
    .replace(/\([^)]*\)/g, '')  // 괄호 안 용량 등 제거: 탕수육(소) → 탕수육
    .replace(/\s+/g, '')
}

// 이미 아이콘이 있는 메뉴명 → 그 아이콘 경로. 이게 돌려쓸 재료다.
const haveRows = await sql`
  select distinct on (name) name, image_url
  from menus where image_url is not null
`
// 정규화한 이름으로도 찾을 수 있게 색인. 긴 것부터 매칭하려고 정렬해 둔다.
const iconByNorm = new Map()
for (const r of haveRows) {
  const key = normalize(r.name)
  if (!iconByNorm.has(key)) iconByNorm.set(key, r.image_url)
}
const keys = [...iconByNorm.keys()].sort((a, b) => b.length - a.length)

/** 메뉴명 안에 아이콘 재료가 들어있으면 그 아이콘을 돌려준다. */
function findIcon(name) {
  const n = normalize(name)
  // 정확히 같으면 그대로 (정규화 덕에 오타/용량도 여기서 잡힌다)
  if (iconByNorm.has(n)) return iconByNorm.get(n)
  // 포함 관계: "소고기김밥"은 "김밥"을 품는다. 긴 키워드부터 봐서 "김치찌개"가
  // "김밥"보다 먼저 걸리게 한다. 단 너무 짧은 키(2글자 미만)는 오매칭이 많아 건너뛴다.
  for (const k of keys) {
    if (k.length >= 2 && n.includes(k)) return iconByNorm.get(k)
  }
  return null
}

const need = await sql`
  select distinct name from menus where is_available and image_url is null
`
let matched = 0, unmatched = 0
const samples = []
const unmatchedCommon = []

for (const { name } of need) {
  const icon = findIcon(name)
  if (icon) {
    matched++
    if (samples.length < 15) samples.push(`${name} → ${icon.split('/').pop()}`)
    if (!DRY) {
      await sql`update menus set image_url = ${icon}, updated_at = now() where name = ${name} and image_url is null`
    }
  } else {
    unmatched++
    unmatchedCommon.push(name)
  }
}

console.log(`아이콘 없던 메뉴명 ${need.length}개`)
console.log(`  돌려쓰기로 매칭: ${matched}개`)
console.log(`  여전히 없음: ${unmatched}개\n`)

console.log('=== 매칭 예시 ===')
samples.forEach((s) => console.log(`  ${s}`))

// 여전히 아이콘 없는 것 중 흔한 것 — 이게 추가 생성 후보다
const stillCommon = await sql`
  select name, count(*)::int as n from menus
  where is_available and name = any(${unmatchedCommon})
  group by name order by count(*) desc limit 15
`
console.log('\n=== 아직 아이콘 없는 것 중 흔한 것 (추가 생성 후보) ===')
stillCommon.forEach((r) => console.log(`  ${r.name} — ${r.n}곳`))

if (!DRY) {
  const [stat] = await sql`
    select count(*) filter (where image_url is not null)::int as with_icon, count(*)::int as total
    from menus where is_available
  `
  console.log(`\n메뉴 커버리지: ${stat.with_icon}/${stat.total} (${(stat.with_icon / stat.total * 100).toFixed(1)}%)`)
}
await sql.end()
