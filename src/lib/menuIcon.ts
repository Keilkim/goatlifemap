import type { Menu } from '@/lib/types'

/**
 * 메뉴에 보여줄 아이콘 경로. 진짜 아이콘이 있으면 그걸, 없으면 업종 폴백을 쓴다.
 * 둘 다 없으면 null — 그때만 UI가 X 자리표시를 그린다.
 */
export function menuIcon(m: Pick<Menu, 'image_url' | 'fallback_icon'>): string | null {
  return m.image_url ?? m.fallback_icon ?? null
}
