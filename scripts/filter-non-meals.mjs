// "한 끼"가 아닌 메뉴를 걸러낸다.
//
// 이 서비스의 문장은 "1끼 기준 만원 이하"다. 그런데 착한가격업소에 고깃집이 섞여
// 들어오면서, 고기 1인분 단품 가격이 메뉴로 올라왔다:
//   생삼겹살(200g) 7,900 — 만원 이하지만 이걸 혼자 시켜 점심으로 먹진 않는다
//   한우 육회(150g) 29,000 — 애초에 한 끼가 아니다
//   김치찌개 2인기준 12,000 — 1인분이 아니다
//
// 이런 걸 안 보이게 한다. 삭제가 아니라 is_available=false로 내린다:
//   나중에 판단이 틀렸다고 밝혀지면 되돌릴 수 있어야 하고,
//   가게 자체는 (된장찌개 같은 진짜 한 끼가 있으면) 지도에 남아야 한다.
//
// 사용법:
//   node scripts/filter-non-meals.mjs --dry    # 뭐가 걸러지는지 보기만
//   node scripts/filter-non-meals.mjs

import postgres from 'postgres'
import { readFileSync } from 'node:fs'

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch { /* .env 없으면 환경변수 */ }

const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/jumsim'
const DRY = process.argv.includes('--dry')
const sql = postgres(DB, { max: 4 })

// 한 끼가 아닌 것으로 판정하는 규칙. 하나라도 걸리면 내린다.
const RULES = [
  // 무게 표기가 있는 고기 단품: 생삼겹살(200g), 목살 180g, 차돌박이 150g
  { name: 'weight', re: /\d{2,4}\s*g\b|\(\s*\d{2,4}\s*g/ },
  // 인분/N인 기준: 김치찌개 2인기준, 감자탕(중), 반마리, 한마리.
  // (소)는 뺐다 — 컵밥(소)·갈치조림(소)처럼 1인 한 끼에도 붙는다. (대)/(중)만 본다.
  { name: 'portion', re: /\d\s*인\s*(기준|분|이상)|반마리|한마리|\((대|중)\)|대\)|중\)/ },
  // 구워 먹는 고기 단품 (찌개·덮밥·정식이 아닌, 고기 이름만 있는 것).
  // "삼겹살"은 걸러도 "삼겹살덮밥"·"삼겹쌈밥"은 한 끼이므로 남긴다.
  // '모둠/모듬'은 뺐다 — 모듬초밥·모둠회처럼 고기가 아닌 한 끼에도 쓰여 오탐이 난다.
  // 부정형 예외의 '국'을 '국밥|해장국'으로 좁혔다. 그냥 '국'으로 두면 삼겹살(외국산)의
  // '외국산'에 든 '국'이 국물요리로 오해돼서 안 걸린다 (실제로 그랬다).
  { name: 'raw-meat', re: /(삼겹살|생?오겹살|생?목살|항정살|갈매기살|차돌박이|생고기|한우|꽃등심|주물럭|오리로스|생막창|돼지막창|소막창|돼지껍데기|소갈비살|돼지갈비)(?!.*(덮밥|정식|백반|쌈밥|찌개|찌게|국밥|해장국|탕|볶음|비빔|전골))/ },
]

// 예외: 이름에 이게 들어있으면 한 끼로 본다 (위 규칙보다 우선).
// 전골/두루치기/컵밥은 밥과 함께 먹는 한 끼다 — 고기 이름이 섞여 있어도 남긴다.
const KEEP = /덮밥|정식|백반|쌈밥|찌개|찌게|국밥|해장국|비빔|볶음밥|한상|도시락|세트메뉴|전골|두루치기|컵밥|김밥|국수|냉면/

// 만원 이하만 대상으로 한다. 만원 넘는 건 어차피 필터에서 안 보이므로 건드릴 이유가
// 없고, 건드리면 오탐 위험만 는다. 15,000원 갈치조림(소)을 잘못 내려봐야 얻는 게 없다.
const rows = await sql`
  select m.id, m.name, m.price, s.name as store, s.id as store_id
  from menus m join stores s on s.id = m.store_id
  where m.is_available and m.price <= 10000
`

const toHide = []
for (const r of rows) {
  if (KEEP.test(r.name)) continue
  const hit = RULES.find((rule) => rule.re.test(r.name))
  if (hit) toHide.push({ ...r, rule: hit.name })
}

// 가게가 통째로 사라지는지 확인한다. 고기 단품만 내렸는데 그 가게에 한 끼 메뉴가
// 하나도 안 남으면, 그건 애초에 고깃집이라 지도에서 빠지는 게 맞다 — 하지만 그 사실을
// 눈으로 보고 넘어가야 한다.
const hideByStore = new Map()
for (const r of toHide) {
  if (!hideByStore.has(r.store_id)) hideByStore.set(r.store_id, [])
  hideByStore.get(r.store_id).push(r)
}
const emptied = []
for (const [storeId, hidden] of hideByStore) {
  const [{ remaining }] = await sql`
    select count(*)::int as remaining from menus
    where store_id = ${storeId} and is_available and id != all(${hidden.map((h) => h.id)})
  `
  if (remaining === 0) emptied.push({ store: hidden[0].store, count: hidden.length })
}

console.log(`전체 메뉴 ${rows.length}개 중 "한 끼 아님"으로 판정: ${toHide.length}개\n`)

const byRule = {}
for (const r of toHide) byRule[r.rule] = (byRule[r.rule] ?? 0) + 1
console.log('=== 규칙별 ===')
for (const [k, v] of Object.entries(byRule)) console.log(`  ${k}: ${v}개`)

console.log('\n=== 걸러질 메뉴 예시 ===')
for (const r of toHide.slice(0, 20)) console.log(`  [${r.rule}] ${r.name} ${r.price}원 · ${r.store}`)

console.log(`\n=== 이걸 내리면 메뉴가 0개가 되는 가게 (고깃집으로 판단) ===`)
console.log(`  ${emptied.length}곳`)
for (const e of emptied.slice(0, 10)) console.log(`  ${e.store} (${e.count}개 전부 고기단품)`)

if (!DRY) {
  const ids = toHide.map((r) => r.id)
  await sql`update menus set is_available = false, updated_at = now() where id = any(${ids})`
  const [stat] = await sql`
    select count(*) filter (where is_available)::int as active,
           count(distinct store_id) filter (where is_available)::int as stores
    from menus
  `
  console.log(`\n적용됨. 남은 메뉴 ${stat.active}개 · 메뉴 있는 가게 ${stat.stores}곳`)
}
await sql.end()
