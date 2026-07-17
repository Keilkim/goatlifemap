/**
 * 별점 색.
 *
 * 평점이 없으면 옅은 회색 — 숨기지 않는다. 자리가 사라졌다 나타나면 목록이 흔들리고,
 * "아직 아무도 안 남겼다"는 것도 정보다.
 * 평점이 있으면 주황색이고 높을수록 진하다. 숫자를 읽기 전에 색으로 먼저 걸러진다.
 * 3점을 바닥으로 잡는 이유: 1~2점짜리를 진한 주황으로 칠하면 좋은 집처럼 보인다.
 */
export function ratingColor(value: number | null): string {
  if (value === null || value <= 0) return 'rgb(60 60 67 / 0.32)'
  // 3.0 → 옅은 주황, 5.0 → 진한 주황
  const t = Math.min(1, Math.max(0, (value - 3) / 2))
  const light = [255, 176, 122]
  const deep = [214, 84, 0]
  const c = light.map((l, i) => Math.round(l + (deep[i] - l) * t))
  return `rgb(${c[0]} ${c[1]} ${c[2]})`
}

/**
 * 가격 확인일.
 * 이 서비스는 "지금 그 가격이 맞나"가 전부라, 확인일이 곧 신뢰도다.
 * 그래서 날짜를 숨기지 않고 항상 같이 보여준다.
 */
export function daysAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (days <= 0) return '오늘'
  if (days === 1) return '어제'
  if (days < 30) return `${days}일 전`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}달 전`
  return `${Math.floor(months / 12)}년 전`
}
