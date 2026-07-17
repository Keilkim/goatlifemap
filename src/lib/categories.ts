// 업태 필터.
//
// 공공데이터의 UPTAENM은 사용자가 쓰는 말과 다르다. 실제 값을 확인해보면:
//   한식 · 기타 · 일식 · 경양식 · 호프/통닭 · 분식 · 중국식 · 까페 ·
//   외국음식전문점(인도,태국등) · 통닭(치킨) · 식육(숯불구이) · 횟집 ...
//
// 특히 "중식"은 데이터에 없다. "중국식"이다. 화면에 "중식"이라 쓰고 그대로 조회하면
// 결과가 0건이 나온다 (실제로 그랬다). 그래서 표시명과 실제 값을 분리한다.
//
// '기타'는 마포구 기준 2위(2,184곳)로 무시할 수 없는 규모지만, 그 안에 뭐가 있는지
// 알 수 없어 필터로 노출하지 않는다. 필터를 안 걸면 어차피 다 나온다.

export type CategoryFilter = { label: string; values: string[] }

export const CATEGORY_FILTERS: CategoryFilter[] = [
  { label: '한식', values: ['한식'] },
  { label: '중식', values: ['중국식'] },
  { label: '일식', values: ['일식', '횟집'] },
  { label: '분식', values: ['분식', '김밥(도시락)'] },
  { label: '양식', values: ['경양식', '외국음식전문점(인도,태국등)'] },
  { label: '치킨·호프', values: ['호프/통닭', '통닭(치킨)'] },
]

/** 화면에 보이는 라벨 → 공공데이터의 실제 업태 값들 */
export function expandCategories(labels: string[]): string[] {
  const out: string[] = []
  for (const l of labels) {
    const f = CATEGORY_FILTERS.find((c) => c.label === l)
    // 못 찾은 라벨은 그대로 넘긴다 — 데이터 원문으로 직접 조회하고 싶을 때를 위해
    if (f) out.push(...f.values)
    else out.push(l)
  }
  return out
}

/**
 * 개별 메뉴 아이콘이 없을 때 쓰는 카테고리 폴백 아이콘.
 *
 * 아이콘 없는 메뉴의 88.5%가 "1곳에만 있는 희귀 메뉴"라 하나씩 아이콘을 만들 수 없다.
 * 그렇다고 X(사진 없음)를 두면 못 채운 티가 난다. 업종 아이콘으로 대신한다 —
 * "한식 한 그릇" 실루엣이 X보다 덜 휑하고, 어차피 그 자리가 뭘 파는 곳인지는 맞다.
 */
export function categoryIcon(category: string | null): string {
  const c = category ?? ''
  if (c.startsWith('중국')) return '/icons/cat/chinese.png'
  if (c.startsWith('일식') || c.includes('횟집') || c.includes('초밥')) return '/icons/cat/japanese.png'
  if (c.includes('분식') || c.includes('김밥')) return '/icons/cat/bunsik.png'
  if (c.startsWith('경양식') || c.startsWith('외국음식')) return '/icons/cat/western.png'
  if (c.startsWith('한식')) return '/icons/cat/korean.png'
  return '/icons/cat/etc.png'
}
