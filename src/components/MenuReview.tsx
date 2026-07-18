'use client'

import { useEffect, useState } from 'react'
import type { Menu } from '@/lib/types'
import { daysAgo } from '@/lib/format'
import Rating from './Rating'
import { menuIcon } from '@/lib/menuIcon'

// 선택형 리뷰.
//
// 장문을 쓰게 하지 않는다. 사업계획서대로 "빠르게 참여할 수 있는 선택형"이 중심이다 —
// 빨리 참여할 수 있어야 정보가 쌓이고, 쌓여야 이 서비스가 산다.
// 가격 검증(맞아요/안 팔아요)이 맨 앞에 오는 이유는 그게 이 서비스의 생사이기 때문이다.
const TAGS = [
  { key: 'good_value', label: '가성비 좋아요' },
  { key: 'portion_big', label: '양 많아요' },
  { key: 'tasty', label: '맛있어요' },
  { key: 'fast', label: '빨리 나와요' },
  { key: 'solo_ok', label: '혼밥 좋아요' },
  { key: 'portion_small', label: '양 적어요' },
] as const

type Review = {
  id: string
  tags: string[]
  comment: string | null
  image_url: string | null
  created_at: string
}

type VerificationKind = 'price_ok' | 'price_changed' | 'discontinued'

/** 길찾기 — 사람이 걸어가는 모양. MenuList의 것과 같은 아이콘. */
function WalkIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.2" cy="4.2" r="1.7" />
      <path d="M12.4 21l1.3-5.6-2.8-2.7.9-4.5M8 21l2.3-4.6M11.8 8.2L8.8 9.8 7.4 12.9M11.8 8.2l3.5 1.3 1.9 3.3" />
    </svg>
  )
}

export default function MenuReview({
  menu, storeName, onVerify, onDirections, onShowMenus, onCompose, refreshKey,
}: {
  menu: Menu
  storeName: string
  // reportedPrice는 '가격이 바뀌었어요'(price_changed)일 때만 채워진다.
  // 성공 여부를 돌려줘 호출부가 성공했을 때만 '접수됐어요'를 띄운다.
  onVerify: (menuId: string, kind: VerificationKind, reportedPrice?: number) => Promise<boolean>
  onDirections: () => void
  onShowMenus: () => void
  // 리뷰 쓰기는 전체화면(ReviewCompose)으로 뺐다. 이 시트는 읽기 전용.
  onCompose: () => void
  // 작성 화면에서 등록에 성공하면 이 값이 바뀌어 리뷰 목록을 다시 불러온다.
  refreshKey: number
}) {
  // 다른 메뉴로 바뀌면 부모가 key로 이 컴포넌트를 새로 만든다.
  const [reviews, setReviews] = useState<Review[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  // 가격 변경 제보: 버튼을 누르면 바뀐 가격 입력칸이 열린다.
  const [changing, setChanging] = useState(false)
  const [newPrice, setNewPrice] = useState('')
  const [reportedKind, setReportedKind] = useState<VerificationKind | null>(null)
  const [submittingKind, setSubmittingKind] = useState<VerificationKind | null>(null)

  const submitVerification = async (kind: 'price_ok' | 'discontinued') => {
    setSubmittingKind(kind)
    try {
      const ok = await onVerify(menu.id, kind)
      if (ok) setReportedKind(kind)
    } finally {
      setSubmittingKind(null)
    }
  }

  const submitChange = async () => {
    const n = parseInt(newPrice, 10)
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
      alert('바뀐 가격을 숫자로 입력해주세요')
      return
    }
    // 서버가 실제로 받아준 경우에만 '접수됐어요'를 띄운다. 실패(중복·차단·오프라인)면
    // onVerify가 alert하고 false를 주므로, 입력창을 그대로 둔다.
    setSubmittingKind('price_changed')
    try {
      const ok = await onVerify(menu.id, 'price_changed', n)
      if (ok) {
        setChanging(false)
        setNewPrice('')
        setReportedKind('price_changed') // 운영자 승인 대기 — 지도엔 승인 후 반영된다
      }
    } finally {
      setSubmittingKind(null)
    }
  }

  useEffect(() => {
    // 화면이 사라진 뒤 도착한 응답으로 상태를 건드리지 않는다
    let alive = true
    fetch(`/api/reviews?menuId=${menu.id}`)
      .then((r) => r.json())
      .then((d: { reviews: Review[]; tagCounts: Record<string, number> }) => {
        if (!alive) return
        setReviews(d.reviews ?? [])
        setCounts(d.tagCounts ?? {})
      })
      .catch(() => { /* 리뷰가 안 떠도 가격은 보여야 한다 */ })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // refreshKey가 바뀌면(작성 화면에서 등록 성공) 목록을 다시 불러온다.
  }, [menu.id, refreshKey])

  return (
    <div className="px-4 pb-4">
      {/* 길찾기 + 다른 메뉴도 보기.
          지도에서 메뉴를 바로 눌러 들어오면 이 가게의 다른 메뉴로 갈 길이 없다 —
          '다른 메뉴도 보기'가 그 통로다. 길찾기는 주황(주요 동작), 다른 메뉴 보기는
          나머지 버튼들과 같은 화이트. */}
      <div className="mb-3 flex flex-col gap-1.5">
        <button
          onClick={onDirections}
          className="jm-press t-caption flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#ff7a18] py-2 text-[13px] font-semibold text-white"
        >
          <WalkIcon />
          길찾기
        </button>
        <button
          onClick={onShowMenus}
          className="jm-press t-caption w-full rounded-xl bg-black/[0.05] py-2 text-[13px] font-semibold text-[#3c3c43]/75 dark:bg-white/[0.09] dark:text-[#ebebf5]/75"
        >
          다른 메뉴도 보기
        </button>
      </div>

      {/* 가격이 이 화면의 주인공이다 */}
      <div className="flex items-center gap-3 rounded-2xl bg-black/[0.03] p-3 dark:bg-white/[0.05]">
        {menuIcon(menu) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={menuIcon(menu)!} alt="" className="size-14 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.07]" aria-hidden>
            <svg viewBox="0 0 24 24" className="size-4 text-black/20 dark:text-white/25" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M7 7l10 10M17 7L7 17" />
            </svg>
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="t-price text-[20px] font-bold text-[#1c1c1e] dark:text-[#f2f2f7]">
              {menu.price.toLocaleString()}
              <span className="ml-0.5 text-[12px] font-medium text-[#3c3c43]/50 dark:text-[#ebebf5]/50">원</span>
            </p>
            <Rating value={menu.rating} count={menu.rating_count} size="md" />
          </div>
          <p className="t-caption truncate text-[11.5px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
            {storeName} · 가격 확인 {daysAgo(menu.verified_at)}
          </p>
        </div>
      </div>

      {/* 메뉴 정보 검증. 가격이 맞다는 확인은 확인일을 갱신하고, 가격 변경·단종 제보는
          운영자 승인 대기열로 보낸다. 서버가 접수에 성공한 경우에만 완료 상태를 보여준다. */}
      {reportedKind ? (
        <p className="t-caption mt-3 rounded-xl bg-black/[0.03] py-2.5 text-center text-[12px] font-semibold text-[#3c3c43]/60 dark:bg-white/[0.05] dark:text-[#ebebf5]/60">
          {reportedKind === 'price_ok'
            ? '접수됐어요 · 운영자 확인 후 +5P 지급돼요'
            : '접수됐어요 · 운영자 확인 후 반영·지급돼요'}
        </p>
      ) : changing ? (
        <div className="mt-3 flex gap-1.5">
          <input
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value.replace(/[^0-9]/g, ''))}
            inputMode="numeric"
            autoFocus
            disabled={submittingKind !== null}
            placeholder="바뀐 가격"
            className="t-price min-w-0 flex-1 rounded-xl bg-black/[0.05] px-3 py-2 text-[13px] font-semibold text-[#1c1c1e] placeholder:font-medium placeholder:text-[#3c3c43]/40 disabled:opacity-60 dark:bg-white/[0.09] dark:text-[#f2f2f7] dark:placeholder:text-[#ebebf5]/40"
          />
          <button
            onClick={submitChange}
            disabled={submittingKind !== null}
            className="jm-press t-caption shrink-0 rounded-xl bg-[#ff7a18] px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-60"
          >
            {submittingKind === 'price_changed' ? '접수 중…' : '제보'}
          </button>
          <button
            onClick={() => { setChanging(false); setNewPrice('') }}
            disabled={submittingKind !== null}
            className="jm-press t-caption shrink-0 rounded-xl bg-black/[0.05] px-3 py-2 text-[12px] font-semibold text-[#3c3c43]/60 disabled:opacity-60 dark:bg-white/[0.09] dark:text-[#ebebf5]/60"
          >
            취소
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-1.5">
          <div className="flex gap-1.5">
            <button
              onClick={() => void submitVerification('price_ok')}
              disabled={submittingKind !== null}
              className="jm-press t-caption flex-1 rounded-xl bg-black/[0.05] py-2.5 text-[12px] font-semibold text-[#3c3c43]/75 disabled:opacity-60 dark:bg-white/[0.09] dark:text-[#ebebf5]/75"
            >
              {submittingKind === 'price_ok' ? '접수 중…' : '가격 맞아요 · +5P'}
            </button>
            <button
              onClick={() => void submitVerification('discontinued')}
              disabled={submittingKind !== null}
              className="jm-press t-caption flex-1 rounded-xl bg-black/[0.05] py-2.5 text-[12px] font-semibold text-[#3c3c43]/75 disabled:opacity-60 dark:bg-white/[0.09] dark:text-[#ebebf5]/75"
            >
              {submittingKind === 'discontinued' ? '접수 중…' : '메뉴가 없어졌어요 · +20P'}
            </button>
          </div>
          <button
            onClick={() => setChanging(true)}
            disabled={submittingKind !== null}
            className="jm-press t-caption w-full rounded-xl bg-black/[0.05] py-2.5 text-[12.5px] font-semibold text-[#3c3c43]/75 disabled:opacity-60 dark:bg-white/[0.09] dark:text-[#ebebf5]/75"
          >
            가격이 바뀌었어요 · +20P
          </button>
        </div>
      )}

      {/* 남들이 남긴 태그 요약(읽기 전용). 쓰기는 아래 '리뷰 쓰기'에서 전체화면으로. */}
      {Object.keys(counts).length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {TAGS.filter((t) => (counts[t.key] ?? 0) > 0).map((t) => (
            <span
              key={t.key}
              className="jm-chip t-caption rounded-full px-2.5 py-1.5 text-[12px] font-medium text-[#3c3c43]/70 dark:text-[#ebebf5]/70"
            >
              {t.label} <span className="opacity-55">{counts[t.key]}</span>
            </span>
          ))}
        </div>
      )}

      {/* 리뷰 쓰기 — 별점·태그·코멘트는 좁은 시트 대신 전체화면에서 쓴다 */}
      <button
        onClick={onCompose}
        className="jm-press t-caption mt-4 w-full rounded-xl bg-[#1c1c1e] py-2.5 text-[13px] font-semibold text-white dark:bg-white dark:text-[#1c1c1e]"
      >
        리뷰 쓰기 · +10P
      </button>

      {/* 남의 리뷰 */}
      {!loading && reviews.length > 0 && (
        <ul className="mt-4 space-y-2">
          {reviews.map((r) => (
            <li key={r.id} className="rounded-2xl bg-black/[0.03] p-2.5 dark:bg-white/[0.05]">
              <div className="flex flex-wrap items-center gap-1">
                {r.tags.map((t) => (
                  <span key={t} className="t-caption rounded-full bg-black/[0.05] px-1.5 py-0.5 text-[10.5px] font-medium text-[#3c3c43]/70 dark:bg-white/[0.09] dark:text-[#ebebf5]/70">
                    {TAGS.find((x) => x.key === t)?.label ?? t}
                  </span>
                ))}
                <span className="t-caption ml-auto text-[10px] font-medium text-[#3c3c43]/40 dark:text-[#ebebf5]/40">
                  {daysAgo(r.created_at)}
                </span>
              </div>
              {r.comment && (
                <p className="t-body mt-1 text-[12.5px] text-[#1c1c1e] dark:text-[#f2f2f7]">{r.comment}</p>
              )}
              {r.image_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.image_url} alt="" loading="lazy" className="mt-1.5 h-28 w-full rounded-xl object-cover" />
              )}
            </li>
          ))}
        </ul>
      )}

      {!loading && reviews.length === 0 && (
        <p className="t-caption mt-4 text-center text-[11.5px] font-medium text-[#3c3c43]/40 dark:text-[#ebebf5]/40">
          아직 리뷰가 없어요. 첫 번째로 알려주세요
        </p>
      )}
    </div>
  )
}
