'use client'

import { useEffect, useRef } from 'react'
import { animate } from 'motion'
import { sheetEnterKeyframes } from '@/lib/layout'

/**
 * 하단 시트.
 *
 * 지도가 화면 전부이므로 자세한 건 아래에서 올라온다. 두 가지만 담는다:
 *   1. 그 가게의 전체 메뉴
 *   2. 그 메뉴의 리뷰
 *
 * 스프링으로 올린다. 아래에서 밀어 올린 것처럼 읽혀야 어디서 왔는지 알 수 있고,
 * 닫을 때 같은 길로 내려가야 공간 관계가 유지된다.
 */
export default function Sheet({
  open, onClose, onBack, title, subtitle, children,
}: {
  open: boolean
  onClose: () => void
  /** 이전 시트에서 왔으면 뒤로가기를 준다. 없으면 닫기만. */
  onBack?: () => void
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !open) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      animate(el, { opacity: [0, 1] }, { duration: 0.18 })
      return
    }
    // 제스처로 던진 게 아니므로 오버슈트 없이(bounce 0) 들어온다.
    // 하단 시트면 아래에서, 우측 패널이면 옆에서 — 어디서 왔는지 방향으로 읽힌다.
    animate(
      el,
      { transform: sheetEnterKeyframes() },
      { type: 'spring', bounce: 0, duration: 0.42 }
    )
  }, [open])

  if (!open) return null

  return (
    <>
      {/* 시트는 지도를 덮으므로 뒤를 어둡게 해서 초점을 옮긴다.
          지도 위 카드와 달리 이건 "지금 이걸 보라"는 화면이다. */}
      <button
        aria-label="닫기"
        onClick={onClose}
        className="jm-scrim absolute inset-0 z-[1190]"
      />

      {/* 시트는 큰 표면이고 그 위에 글을 읽어야 한다. 지도 위 핀과 같은 얇은 유리로
          만들면 지도가 그대로 비쳐 글자가 안 읽힌다 — 큰 표면일수록 두껍게. */}
      <div
        ref={ref}
        className="jm-sheet absolute inset-x-0 bottom-0 z-[1200] max-h-[68%] overflow-hidden rounded-t-[20px] will-change-transform jm-side-card side:flex side:max-h-none side:w-[400px] side:max-w-[86vw] side:flex-col side:rounded-[24px]"
      >
        {/* 손잡이 — 아래에서 올라온 물건이라는 표시 */}
        <div className="flex justify-center pb-1 pt-2">
          <span className="h-1 w-9 rounded-full bg-[#3c3c43]/20 dark:bg-[#ebebf5]/20" aria-hidden />
        </div>

        <div className="flex items-start gap-1.5 px-4 pb-2">
          {onBack && (
            <button
              onClick={onBack}
              aria-label="뒤로"
              className="jm-press -ml-1 flex size-7 shrink-0 items-center justify-center rounded-full text-[#3c3c43]/60 dark:text-[#ebebf5]/60"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 5l-7 7 7 7" />
              </svg>
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className="t-title truncate text-[16px] font-bold text-[#1c1c1e] dark:text-[#f2f2f7]">{title}</p>
            {subtitle && (
              <p className="t-caption mt-px truncate text-[11.5px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
                {subtitle}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="닫기"
            className="jm-press flex size-7 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-[#3c3c43]/45 dark:bg-white/[0.09] dark:text-[#ebebf5]/45"
          >
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
              <path d="M7 7l10 10M17 7L7 17" />
            </svg>
          </button>
        </div>

        <div className="jm-scroll max-h-[calc(68vh-72px)] overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)] side:max-h-none side:min-h-0 side:flex-1">
          {children}
        </div>
      </div>
    </>
  )
}
