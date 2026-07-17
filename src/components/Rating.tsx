import { ratingColor } from '@/lib/format'

/**
 * 메뉴 별점.
 *
 * 평점이 없으면 숨기지 않고 0.0을 옅은 회색으로 보여준다 — 자리가 사라졌다 나타나면
 * 목록이 흔들리고, "아직 아무도 안 남겼다"는 것도 정보다.
 * 평점이 있으면 주황색이고, 높을수록 진하다. 숫자를 읽기 전에 색으로 먼저 걸러진다.
 */
export default function Rating({
  value, count, size = 'sm',
}: {
  value: number | null
  count?: number
  size?: 'sm' | 'md'
}) {
  const has = value !== null && value > 0
  const px = size === 'md' ? 'text-[12.5px]' : 'text-[10.5px]'
  const star = size === 'md' ? 'size-3.5' : 'size-[11px]'

  return (
    <span
      className={`t-price inline-flex shrink-0 items-center gap-px font-semibold ${px}`}
      style={{ color: ratingColor(value) }}
      title={has ? `평점 ${value!.toFixed(1)}${count ? ` · ${count}명` : ''}` : '아직 평점이 없어요'}
    >
      <svg viewBox="0 0 24 24" className={star} fill="currentColor" aria-hidden>
        <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5-4.7-4.6 6.5-.9z" />
      </svg>
      {has ? value!.toFixed(1) : '0.0'}
    </span>
  )
}
