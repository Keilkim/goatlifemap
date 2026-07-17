'use client'

import { useEffect, useRef } from 'react'
import { animate } from 'motion'
import type { Store } from '@/lib/types'
import { walkMinutes } from '@/lib/coords'

// 마커를 누르면 지도 위에 뜨는 플로팅 카드.
// 한 가게를 묶어서 보여주고, 그 안에 메뉴를 최대 5개까지 편다.
// 마커를 메뉴 단위로 쪼개면 같은 건물에 마커가 겹쳐 지도를 못 쓰게 되므로,
// 묶음은 가게 단위로 유지하고 메뉴는 이 카드 안에서 편다.

const MAX_MENUS = 5

/** 사진이 없을 때 자리를 채우는 X 표시. 사진 없는 게 기본값이다. */
function NoImage() {
  return (
    <div
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.07]"
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="size-2.5 text-black/20 dark:text-white/25" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
        <path d="M7 7l10 10M17 7L7 17" />
      </svg>
    </div>
  )
}

/** 길찾기 — 사람이 걸어가는 모양 */
function WalkIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-[17px]" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.2" cy="4.2" r="1.7" />
      <path d="M12.4 21l1.3-5.6-2.8-2.7.9-4.5" />
      <path d="M8 21l2.3-4.6" />
      <path d="M11.8 8.2L8.8 9.8 7.4 12.9" />
      <path d="M11.8 8.2l3.5 1.3 1.9 3.3" />
    </svg>
  )
}

// 닫기 버튼이 없는 이유: Leaflet 팝업이라 지도 아무 데나 누르면 닫힌다.
// 좁은 카드에 X를 넣으면 길찾기 버튼과 자리를 다투기만 한다.
export default function StoreCard({
  store, distance, onDirections, onMenuClick,
}: {
  store: Store
  distance: number | null
  onDirections: () => void
  onMenuClick: (menuId: string) => void
}) {
  const menus = store.menus.slice(0, MAX_MENUS)
  const hidden = store.menus.length - menus.length
  const ref = useRef<HTMLDivElement>(null)

  // 유리 표면은 그냥 페이드인하면 안 된다. 블러와 스케일을 같이 올려야
  // "진짜 재질이 도착하는" 것처럼 읽힌다.
  //
  // 스프링을 쓰는 이유: 카드는 마커를 연달아 누르면 중간에 다시 타겟이 바뀐다.
  // 고정 duration 애니메이션은 그때 끊기지만 스프링은 현재 값에서 이어간다.
  // damping 1.0(bounce 0) 기본 — 제스처로 던진 게 아니므로 오버슈트는 어색하다.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      animate(el, { opacity: [0, 1] }, { duration: 0.2 })
      return
    }
    animate(
      el,
      { opacity: [0, 1], transform: ['translateY(14px) scale(0.97)', 'translateY(0px) scale(1)'] },
      { type: 'spring', bounce: 0, duration: 0.4 }
    )
    animate(
      el,
      { backdropFilter: ['blur(0px) saturate(100%)', 'blur(28px) saturate(180%)'] },
      { duration: 0.36, ease: 'easeOut' }
    )
    // 카드가 어느 가게 것인지 바뀌면 다시 재질이 도착한다
  }, [store.id])

  return (
    <div
      ref={ref}
      style={{ WebkitBackdropFilter: 'blur(28px) saturate(180%)' }}
      className="jm-card w-[228px] overflow-hidden rounded-[16px] will-change-transform"
    >
      {/* 헤더: 가게 이름 + 우측 상단 길찾기.
          가벼운 재질 위에 또 가벼운 재질을 얹지 않는다 — 구분은 선이 아니라 여백으로. */}
      <div className="flex items-start gap-1 px-2.5 pb-1 pt-2">
        <div className="min-w-0 flex-1">
          <p className="t-title truncate text-[13.5px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">
            {store.name}
          </p>
          <p className="t-caption mt-px truncate text-[10.5px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
            {store.category}
            {distance !== null && ` · 도보 ${walkMinutes(distance)}분`}
          </p>
        </div>

        <button
          onClick={onDirections}
          aria-label="길찾기"
          title="길찾기"
          className="jm-press flex size-7 shrink-0 items-center justify-center rounded-full bg-[#ff7a18] text-white shadow-[0_2px_6px_rgb(234_88_12/0.32)]"
        >
          <WalkIcon />
        </button>
      </div>

      {/* 메뉴: 왼쪽 원형 사진(없으면 X), 오른쪽 이름과 그 아래 가격.
          검증 버튼은 여기 두지 않는다 — 지도 위 카드는 지도를 가리는 만큼만 값을 해야 하고,
          가격 확인은 아래 메뉴 목록에서 이미 할 수 있다. */}
      <ul className="jm-scroll max-h-[164px] overflow-y-auto overscroll-contain px-1 pb-1">
        {menus.map((m) => (
          <li key={m.id}>
            <button
              onClick={() => onMenuClick(m.id)}
              className="flex w-full items-center gap-2 rounded-[12px] px-1.5 py-1 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
            >
              {m.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.image_url} alt="" loading="lazy" className="size-8 shrink-0 rounded-full object-cover" />
              ) : (
                <NoImage />
              )}

              <span className="min-w-0 flex-1">
                <span className="t-body block truncate text-[12.5px] font-medium text-[#1c1c1e] dark:text-[#f2f2f7]">
                  {m.name}
                </span>
                <span className="t-price block text-[13px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">
                  {m.price.toLocaleString()}
                  <span className="ml-px text-[9.5px] font-medium text-[#3c3c43]/50 dark:text-[#ebebf5]/50">원</span>
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {hidden > 0 && (
        <p className="t-caption pb-1.5 text-center text-[10px] font-medium text-[#3c3c43]/45 dark:text-[#ebebf5]/45">
          메뉴 {hidden}개 더
        </p>
      )}
    </div>
  )
}
