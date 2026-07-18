'use client'

import { useEffect, useRef, useState } from 'react'
import { animate } from 'motion'
import type { Menu } from '@/lib/types'
import { menuIcon } from '@/lib/menuIcon'
import { sheetEnterKeyframes } from '@/lib/layout'

// 리뷰 쓰기 — 전체화면.
//
// 읽기(가격·검증·남의 리뷰)는 바텀시트에 두고, 쓰기는 여기로 뺐다. 시트에 다 넣으면
// 별점·태그·코멘트가 좁은 시트를 빡빡하게 만든다. 별도 URL이 아니라 앱 안 오버레이라
// 지도 맥락과 뒤로가기는 그대로 유지된다.
//
// 코멘트는 서버에서 검열된다(링크·연락처·욕설·도배 → 대기열). 걸리면 status가 pending으로
// 와서 "검토 중"으로 안내한다 — 조용히 등록된 척하지 않는다.

const TAGS = [
  { key: 'good_value', label: '가성비 좋아요' },
  { key: 'portion_big', label: '양 많아요' },
  { key: 'tasty', label: '맛있어요' },
  { key: 'fast', label: '빨리 나와요' },
  { key: 'solo_ok', label: '혼밥 좋아요' },
  { key: 'portion_small', label: '양 적어요' },
] as const

export default function ReviewCompose({
  menu, storeName, onClose, onSubmitted,
}: {
  menu: Menu
  storeName: string
  onClose: () => void
  /** 등록 성공 시 뒤의 리뷰 목록 새로고침 + 헤더 포인트 갱신을 위해 최신 포인트를 넘긴다. */
  onSubmitted: (points: number) => void
}) {
  const [picked, setPicked] = useState<string[]>([])
  const [stars, setStars] = useState(0)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  // 등록 결과 상태값('approved' | 'pending'). null이면 아직 작성 중.
  const [done, setDone] = useState<string | null>(null)

  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // 하단이면 아래에서, 우측 패널이면 옆에서 슬라이드 인
    animate(el, { transform: sheetEnterKeyframes() }, { type: 'spring', bounce: 0, duration: 0.4 })
  }, [])

  // 별점이나 태그가 하나는 있어야 등록된다(서버 규칙과 동일). 코멘트만으론 안 된다.
  const canSubmit = (stars > 0 || picked.length > 0) && !sending

  const submit = async () => {
    if (!canSubmit) return
    const deviceId = localStorage.getItem('jm_device_id')
    if (!deviceId) return
    setSending(true)
    try {
      const res = await fetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: deviceId, menuId: menu.id,
          tags: picked, rating: stars || null,
          comment: comment.trim() || undefined,
        }),
      })
      const d = await res.json()
      if (res.ok) {
        setDone(d.status)
        onSubmitted(d.points) // 뒤 목록 새로고침 + 헤더 포인트 갱신
      } else {
        alert(d.error)
      }
    } catch {
      alert('연결이 불안정해요')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      {/* 우측 패널 모드에선 이 폼이 400px 카드라, 뒤를 막아줄 자기 스크림이 필요하다.
          없으면 뒤에 깔린 리뷰 시트의 스크림이 눌려 그 시트만 닫히고 작성 폼이 홀로 떠서
          지도·토글이 다시 살아난다. 전체화면(하단 모드)에선 카드가 이 스크림을 덮어 안 보인다. */}
      <button aria-label="닫기" onClick={onClose} className="jm-scrim absolute inset-0 z-[1290]" />
      <div ref={ref} className="jm-sheet absolute inset-0 z-[1300] flex flex-col will-change-transform jm-side-card side:w-[400px] side:max-w-[86vw] side:overflow-hidden side:rounded-[24px]">
      {/* 헤더 — 뒤로가기 + 제목 */}
      <div className="flex items-center gap-1.5 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+10px)]">
        <button
          onClick={onClose}
          aria-label="뒤로"
          className="jm-press -ml-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-[#3c3c43]/60 dark:text-[#ebebf5]/60"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <p className="t-title flex-1 text-[16px] font-bold text-[#1c1c1e] dark:text-[#f2f2f7]">리뷰 쓰기</p>
      </div>

      <div className="jm-scroll flex-1 overflow-y-auto px-4 pb-6">
        {/* 어느 메뉴인지 */}
        <div className="flex items-center gap-3 rounded-2xl bg-black/[0.03] p-3 dark:bg-white/[0.05]">
          {menuIcon(menu) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={menuIcon(menu)!} alt="" className="size-12 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.07]" aria-hidden>
              <svg viewBox="0 0 24 24" className="size-4 text-black/20 dark:text-white/25" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M7 7l10 10M17 7L7 17" />
              </svg>
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="t-body truncate text-[14.5px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">{menu.name}</p>
            <p className="t-caption truncate text-[11.5px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
              {storeName} · {menu.price.toLocaleString()}원
            </p>
          </div>
        </div>

        {done ? (
          // 등록/검토 결과
          <div className="mt-8 text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-[#ff7a18]/12">
              <svg viewBox="0 0 24 24" className="size-7 text-[#ff7a18]" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="t-title mt-3 text-[15px] font-bold text-[#1c1c1e] dark:text-[#f2f2f7]">
              {done === 'pending' ? '검토 중이에요' : '고마워요, 등록됐어요'}
            </p>
            <p className="t-caption mt-1 text-[12px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
              {done === 'pending'
                ? '운영자 확인 후 보여요 · +10P도 그때 지급'
                : '포인트(+10P)는 운영자 확인 후 지급돼요'}
            </p>
            <button
              onClick={onClose}
              className="jm-press t-caption mt-6 w-full rounded-xl bg-[#1c1c1e] py-3 text-[14px] font-semibold text-white dark:bg-white dark:text-[#1c1c1e]"
            >
              닫기
            </button>
          </div>
        ) : (
          <>
            {/* 별점 */}
            <p className="t-caption mt-5 text-[12px] font-semibold text-[#3c3c43]/55 dark:text-[#ebebf5]/55">별점</p>
            <div className="mt-1.5 flex gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} onClick={() => setStars(stars === n ? 0 : n)} aria-label={`${n}점`} className="jm-press p-0.5">
                  <svg viewBox="0 0 24 24" className="size-9" style={{ color: n <= stars ? '#ff7a18' : 'rgb(60 60 67 / 0.18)' }} fill="currentColor">
                    <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5-4.7-4.6 6.5-.9z" />
                  </svg>
                </button>
              ))}
            </div>

            {/* 태그 */}
            <p className="t-caption mt-5 text-[12px] font-semibold text-[#3c3c43]/55 dark:text-[#ebebf5]/55">어땠어요?</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {TAGS.map((t) => {
                const on = picked.includes(t.key)
                return (
                  <button
                    key={t.key}
                    onClick={() => setPicked((p) => (p.includes(t.key) ? p.filter((x) => x !== t.key) : [...p, t.key]))}
                    className={`jm-chip t-caption rounded-full px-3 py-2 text-[13px] font-medium ${
                      on ? 'bg-[#ff7a18] text-white' : 'bg-black/[0.05] text-[#3c3c43]/70 dark:bg-white/[0.09] dark:text-[#ebebf5]/70'
                    }`}
                  >
                    {t.label}
                  </button>
                )
              })}
            </div>

            {/* 코멘트 — 한 줄. 검열 대상이 되는 자유 텍스트. */}
            <p className="t-caption mt-5 text-[12px] font-semibold text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
              한마디 <span className="font-normal text-[#3c3c43]/40 dark:text-[#ebebf5]/40">(선택)</span>
            </p>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={200}
              rows={3}
              placeholder="예: 양 많고 반찬 리필돼요"
              className="t-body mt-1.5 w-full resize-none rounded-xl bg-black/[0.05] px-3.5 py-3 text-[14px] text-[#1c1c1e] placeholder:text-[#3c3c43]/35 dark:bg-white/[0.09] dark:text-[#f2f2f7] dark:placeholder:text-[#ebebf5]/35"
            />
            <p className="t-caption mt-1 text-right text-[10.5px] font-medium text-[#3c3c43]/35 dark:text-[#ebebf5]/35">
              {comment.length}/200 · 링크·연락처·욕설은 자동으로 걸러져요
            </p>
          </>
        )}
      </div>

      {/* 등록 버튼 — 결과 화면이 아닐 때만 하단 고정 */}
      {!done && (
        <div className="border-t border-[#3c3c43]/10 px-4 py-3 pb-[calc(env(safe-area-inset-bottom)+12px)] side:pb-3 dark:border-[#545458]/40">
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="jm-press t-caption w-full rounded-xl bg-[#1c1c1e] py-3 text-[14px] font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-[#1c1c1e]"
          >
            등록하기 · +10P
          </button>
          {stars === 0 && picked.length === 0 && (
            <p className="t-caption mt-1.5 text-center text-[10.5px] font-medium text-[#3c3c43]/40 dark:text-[#ebebf5]/40">
              별점이나 태그를 하나 이상 골라주세요
            </p>
          )}
        </div>
      )}
      </div>
    </>
  )
}
