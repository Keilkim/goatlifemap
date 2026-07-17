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

export default function MenuReview({
  menu, storeName, onVerify,
}: {
  menu: Menu
  storeName: string
  onVerify: (menuId: string, kind: string) => void
}) {
  // 다른 메뉴로 바뀌면 부모가 key로 이 컴포넌트를 새로 만든다.
  // 그래서 여기서 상태를 되돌릴 필요가 없다 — effect에서 setState로 초기화하면
  // 렌더가 한 번 더 도는 데다, 옛 메뉴의 리뷰가 한 프레임 비친다.
  const [reviews, setReviews] = useState<Review[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [picked, setPicked] = useState<string[]>([])
  const [stars, setStars] = useState(0)
  const [loading, setLoading] = useState(true)
  const [sent, setSent] = useState(false)

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
  }, [menu.id])

  const submit = async () => {
    if (!picked.length && !stars) return
    const deviceId = localStorage.getItem('jm_device_id')
    if (!deviceId) return
    const res = await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: deviceId, menuId: menu.id, tags: picked, rating: stars || null }),
    })
    const d = await res.json()
    if (res.ok) {
      setSent(true)
      setReviews((prev) => [d.review, ...prev])
      setCounts((prev) => {
        const next = { ...prev }
        picked.forEach((t) => { next[t] = (next[t] ?? 0) + 1 })
        return next
      })
    } else {
      alert(d.error)
    }
  }

  return (
    <div className="px-4 pb-4">
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

      {/* 가격 검증이 먼저다. 이 서비스의 생사가 여기 달려 있다. */}
      <div className="mt-3 flex gap-1.5">
        <button
          onClick={() => onVerify(menu.id, 'price_ok')}
          className="jm-press t-caption flex-1 rounded-xl bg-black/[0.05] py-2 text-[12px] font-semibold text-[#3c3c43]/75 dark:bg-white/[0.09] dark:text-[#ebebf5]/75"
        >
          가격 맞아요 · +5P
        </button>
        <button
          onClick={() => onVerify(menu.id, 'sold_out')}
          className="jm-press t-caption flex-1 rounded-xl bg-black/[0.05] py-2 text-[12px] font-semibold text-[#3c3c43]/75 dark:bg-white/[0.09] dark:text-[#ebebf5]/75"
        >
          지금 안 팔아요 · +20P
        </button>
      </div>

      {/* 선택형 리뷰 — 장문 대신 별점과 태그 */}
      <p className="t-caption mt-4 text-[11px] font-semibold text-[#3c3c43]/45 dark:text-[#ebebf5]/45">
        {sent ? '고마워요, 등록됐어요' : '먹어봤다면 알려주세요'}
      </p>

      {!sent && (
        <div className="mt-1.5 flex gap-0.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => setStars(stars === n ? 0 : n)}
              aria-label={`${n}점`}
              className="jm-press p-0.5"
            >
              <svg
                viewBox="0 0 24 24"
                className="size-7"
                style={{ color: n <= stars ? '#ff7a18' : 'rgb(60 60 67 / 0.18)' }}
                fill="currentColor"
              >
                <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5-4.7-4.6 6.5-.9z" />
              </svg>
            </button>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {TAGS.map((t) => {
          const n = counts[t.key] ?? 0
          const on = picked.includes(t.key)
          return (
            <button
              key={t.key}
              disabled={sent}
              onClick={() => setPicked((p) => (p.includes(t.key) ? p.filter((x) => x !== t.key) : [...p, t.key]))}
              className={`jm-chip t-caption rounded-full px-2.5 py-1.5 text-[12px] font-medium disabled:opacity-60 ${
                on
                  ? 'bg-[#ff7a18] text-white'
                  : 'bg-black/[0.05] text-[#3c3c43]/70 dark:bg-white/[0.09] dark:text-[#ebebf5]/70'
              }`}
            >
              {t.label}
              {n > 0 && <span className="ml-1 opacity-60">{n}</span>}
            </button>
          )
        })}
      </div>

      {(picked.length > 0 || stars > 0) && !sent && (
        <button
          onClick={submit}
          className="jm-press t-caption mt-2.5 w-full rounded-xl bg-[#1c1c1e] py-2.5 text-[13px] font-semibold text-white dark:bg-white dark:text-[#1c1c1e]"
        >
          등록하기 · +10P
        </button>
      )}

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
