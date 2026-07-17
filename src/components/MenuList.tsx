'use client'

import type { Store, Menu } from '@/lib/types'
import { daysAgo } from '@/lib/format'
import Rating from './Rating'
import { menuIcon } from '@/lib/menuIcon'

/** 사진이 없는 게 기본이다. 사진까지 요구하면 메뉴 입력이 급격히 느려진다. */
function NoImage({ size = 'size-11' }: { size?: string }) {
  return (
    <span className={`flex ${size} shrink-0 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.07]`} aria-hidden>
      <svg viewBox="0 0 24 24" className="size-3.5 text-black/20 dark:text-white/25" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <path d="M7 7l10 10M17 7L7 17" />
      </svg>
    </span>
  )
}

/**
 * 그 가게의 전체 메뉴.
 * 열리는 길은 둘이다 — 메뉴로 보기에서 "메뉴 N개 더", 또는 식당으로 보기에서 식당을 눌렀을 때.
 */
export default function MenuList({
  store, onMenuClick, onDirections,
}: {
  store: Store
  onMenuClick: (menu: Menu) => void
  onDirections: () => void
}) {
  return (
    <>
      <div className="px-4 pb-2">
        <button
          onClick={onDirections}
          className="jm-press t-caption flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#ff7a18] py-2 text-[13px] font-semibold text-white"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="13.2" cy="4.2" r="1.7" />
            <path d="M12.4 21l1.3-5.6-2.8-2.7.9-4.5M8 21l2.3-4.6M11.8 8.2L8.8 9.8 7.4 12.9M11.8 8.2l3.5 1.3 1.9 3.3" />
          </svg>
          길찾기
        </button>
      </div>

      <ul className="px-2 pb-3">
        {store.menus.map((m) => (
          <li key={m.id}>
            <button
              onClick={() => onMenuClick(m)}
              className="flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left transition-colors hover:bg-black/[0.03] active:bg-black/[0.05] dark:hover:bg-white/[0.05]"
            >
              {menuIcon(m) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={menuIcon(m)!} alt="" loading="lazy" className="size-11 shrink-0 rounded-full object-cover" />
              ) : (
                <NoImage />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="t-body truncate text-[14.5px] font-medium text-[#1c1c1e] dark:text-[#f2f2f7]">
                    {m.name}
                  </span>
                  <Rating value={m.rating} count={m.rating_count} />
                </span>
                <span className="t-caption block text-[11px] font-medium text-[#3c3c43]/45 dark:text-[#ebebf5]/45">
                  가격 확인 {daysAgo(m.verified_at)}
                </span>
              </span>
              <span className="t-price shrink-0 text-[16px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">
                {m.price.toLocaleString()}
                <span className="ml-0.5 text-[11px] font-medium text-[#3c3c43]/50 dark:text-[#ebebf5]/50">원</span>
              </span>
              {/* 누르면 그 메뉴의 리뷰로 들어간다는 표시 */}
              <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-[#3c3c43]/25 dark:text-[#ebebf5]/25" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
