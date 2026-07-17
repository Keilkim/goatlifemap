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
