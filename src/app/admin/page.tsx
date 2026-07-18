'use client'

import { useCallback, useEffect, useState } from 'react'

// 운영 콘솔.
//
// 이 서비스의 모든 사용자 기여(리뷰·가격 제보)는 운영자가 확인해야 지도에 반영·지급된다.
// 여기가 그 확인이 일어나는 곳이다. 앱 본체와 같은 애플 스타일(글래스 카드·주황 강조·
// 스프링 눌림)을 쓰되, 지도가 아니라 시스템 그레이 위에 카드가 묶여 뜨는 설정앱 형태로.
//
// 운영에 필요한 항목을 한 화면에서:
//   ① 리뷰 승인   — 대기(안 뜬 것) 승인/거부, optimistic으로 뜬 것 포인트 확정/내리기
//   ② 가격 제보   — 바뀐 가격 승인(반영+지급)/거부
//   ③ 기기        — 검열에 걸린/차단된 기기 차단·해제
//   ④ 수집 변경   — 공식 데이터가 찾은 가격·단종·폐업 후보 승인/보류/거부
//   ⑤ 포인트 원장 — 누구에게 왜 언제 지급됐는지 확인
//   ⑥ 메뉴 채우기 — 가게 검색해 대표 메뉴 붙이기

type Tab = 'reviews' | 'reports' | 'changes' | 'points' | 'devices' | 'blocks' | 'menus'

type Review = {
  id: string; comment: string | null; reason: string | null; rating: number | null
  tags: string[]; created_at: string; status: string
  menu_name: string; store_name: string; district: string | null
}
type Device = {
  id: string; flag_count: number; blocked_at: string | null
  last_reason: string | null; last_at: string | null
}
type Report = {
  id: string; kind: string; reported_price: number | null; created_at: string
  status: string; points_awarded: boolean
  menu_id: string; menu_name: string; current_price: number; store_name: string; district: string | null
}
type StoreHit = {
  id: string; name: string; category: string | null
  road_address: string | null; menu_count: number; source: string
}
type Block = {
  id: string; target_kind: string; comment_norm: string | null
  reason: string | null; created_at: string; user_id: string | null
}
type StoreReview = {
  id: string; comment: string | null; rating: number | null; tags: string[]
  status: string; reason: string | null; created_at: string; menu_name: string
}
type ChangeItem = {
  id: string; entity_type: string; event_type: string; status: string; summary: string
  source: string; detected_at: string; confirmed_at?: string | null; reviewed_at?: string | null
  store_name: string | null; menu_name: string | null
}
type IngestRun = {
  id: string; source: string; scope: string; full_snapshot: boolean; status: string
  records_seen: number; changes_detected: number; error_text: string | null
  started_at: string; completed_at: string | null
}
type PointEntry = {
  id: string; user_id: string; amount: number; reason: string
  reference_type: string | null; reference_id: string | null
  balance_after: number; created_at: string
}

const REASON: Record<string, string> = { link: '링크', phone: '연락처', dup: '도배', profanity: '욕설', ai: 'AI' }
const KIND: Record<string, string> = { chat: '채팅', review: '리뷰', verification: '검증' }
const INPUT =
  'w-full rounded-xl bg-black/[0.05] px-3.5 py-2.5 text-[14px] text-[#1c1c1e] outline-none placeholder:text-[#3c3c43]/40 focus:bg-black/[0.07] dark:bg-white/[0.09] dark:text-[#f2f2f7] dark:placeholder:text-[#ebebf5]/40'

function ago(iso: string | null): string {
  if (!iso) return ''
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return '방금'
  if (m < 60) return `${m}분 전`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}시간 전`
  return `${Math.floor(h / 24)}일 전`
}

export default function Admin() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [pw, setPw] = useState('')
  const [pwErr, setPwErr] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('reviews')

  const [reviews, setReviews] = useState<Review[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [reports, setReports] = useState<Report[]>([])
  const [blocks, setBlocks] = useState<Block[]>([])
  const [changes, setChanges] = useState<ChangeItem[]>([])
  const [recentChanges, setRecentChanges] = useState<ChangeItem[]>([])
  const [runs, setRuns] = useState<IngestRun[]>([])
  const [pointEntries, setPointEntries] = useState<PointEntry[]>([])

  // 로그인 상태 확인
  useEffect(() => {
    fetch('/api/admin/login').then((r) => r.json()).then((d) => setAuthed(!!d.authed)).catch(() => setAuthed(false))
  }, [])

  const login = async (e: React.FormEvent) => {
    e.preventDefault()
    setPwErr(null)
    const res = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }),
    })
    if (res.ok) { setAuthed(true); setPw('') }
    else { const d = await res.json(); setPwErr(d.error ?? '로그인 실패') }
  }

  // 대기열 로드 — 리뷰·기기는 moderation, 제보는 reports. 401이면 세션 만료로 보고 로그인으로.
  const load = useCallback(async () => {
    try {
      const [mRes, rRes, cRes] = await Promise.all([
        fetch('/api/admin/moderation'),
        fetch('/api/admin/reports'),
        fetch('/api/admin/changes'),
      ])
      if (mRes.status === 401 || rRes.status === 401 || cRes.status === 401) { setAuthed(false); return }
      const m = await mRes.json()
      const r = await rRes.json()
      const c = await cRes.json()
      setReviews(m.pendingReviews ?? [])
      setDevices(m.flaggedDevices ?? [])
      setBlocks(m.recentBlocks ?? [])
      setReports(r.reports ?? [])
      setChanges(c.candidates ?? [])
      setRecentChanges(c.recent ?? [])
      setRuns(c.runs ?? [])
      setPointEntries(c.points ?? [])
    } catch { /* 잠깐 끊겨도 다음 액션에서 다시 로드된다 */ }
  }, [])

  useEffect(() => {
    if (!authed) return
    let active = true
    queueMicrotask(() => { if (active) void load() })
    return () => { active = false }
  }, [authed, load])

  // 액션 후엔 항상 대기열을 다시 불러와 화면과 서버를 맞춘다.
  const act = async (url: string, payload: Record<string, unknown>) => {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    if (res.status === 401) { setAuthed(false); return }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      alert(d.error ?? '처리하지 못했습니다')
      return
    }
    await load()
  }

  if (authed === null) {
    return <main className="grid min-h-dvh place-items-center bg-[#f2f2f7] dark:bg-black" />
  }

  if (!authed) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[#f2f2f7] px-6 dark:bg-black">
        <form onSubmit={login} className="jm-card w-full max-w-xs rounded-3xl p-6">
          <p className="t-title text-center text-[17px] font-bold text-[#1c1c1e] dark:text-[#f2f2f7]">갓생맵 운영</p>
          <p className="t-caption mt-1 text-center text-[12px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">운영자 비밀번호</p>
          <input
            type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus
            placeholder="비밀번호" className={`${INPUT} mt-4`}
          />
          {pwErr && <p className="t-caption mt-2 text-center text-[11.5px] font-semibold text-[#ff3b30]">{pwErr}</p>}
          <button className="jm-press mt-3 w-full rounded-xl bg-[#1c1c1e] py-2.5 text-[14px] font-semibold text-white dark:bg-white dark:text-[#1c1c1e]">
            로그인
          </button>
        </form>
      </main>
    )
  }

  const TABS: { key: Tab; label: string; count: number }[] = [
    { key: 'reviews', label: '리뷰', count: reviews.length },
    { key: 'reports', label: '제보', count: reports.length },
    { key: 'changes', label: '변경', count: changes.length },
    { key: 'points', label: '포인트', count: 0 },
    { key: 'devices', label: '기기', count: devices.filter((d) => !d.blocked_at).length },
    // 감지 로그는 처리 대기열이 아니라 열람용이라 카운트 배지는 달지 않는다.
    { key: 'blocks', label: '감지', count: 0 },
    { key: 'menus', label: '가게', count: 0 },
  ]

  return (
    <main className="min-h-dvh bg-[#f2f2f7] pb-16 dark:bg-black">
      {/* 상단 크롬 — 앱과 같은 반투명 유리 */}
      <div className="jm-chrome sticky top-0 z-10 px-4 pb-2 pt-[calc(env(safe-area-inset-top)+12px)]">
        <div className="flex items-center justify-between">
          <h1 className="t-display text-[19px] font-bold text-[#1c1c1e] dark:text-[#f2f2f7]">운영 콘솔</h1>
          <button onClick={load} className="jm-press t-caption rounded-full bg-black/[0.05] px-3 py-1.5 text-[12px] font-semibold text-[#3c3c43]/70 dark:bg-white/[0.09] dark:text-[#ebebf5]/70">
            새로고침
          </button>
        </div>
        <div className="jm-scroll mt-2.5 flex gap-1.5 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`jm-press t-caption flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${
                tab === t.key ? 'bg-[#1c1c1e] text-white dark:bg-white dark:text-[#1c1c1e]' : 'bg-black/[0.05] text-[#3c3c43]/70 dark:bg-white/[0.09] dark:text-[#ebebf5]/70'
              }`}
            >
              {t.label}
              {t.count > 0 && (
                <span className={`t-price inline-flex min-w-[16px] items-center justify-center rounded-full px-1 text-[10.5px] font-bold ${
                  tab === t.key ? 'bg-white/25 text-white dark:bg-black/20 dark:text-[#1c1c1e]' : 'bg-[#ff7a18] text-white'
                }`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-4 pt-4">
        {tab === 'reviews' && <ReviewsPanel reviews={reviews} act={act} />}
        {tab === 'reports' && <ReportsPanel reports={reports} act={act} />}
        {tab === 'changes' && <ChangesPanel changes={changes} recent={recentChanges} runs={runs} act={act} />}
        {tab === 'points' && <PointsPanel entries={pointEntries} />}
        {tab === 'devices' && <DevicesPanel devices={devices} act={act} />}
        {tab === 'blocks' && <BlocksPanel blocks={blocks} act={act} />}
        {tab === 'menus' && <MenusPanel onAuthLost={() => setAuthed(false)} />}
      </div>
    </main>
  )
}

// ── 공통 빈 상태 ────────────────────────────────────────────────────────────
function Empty({ text }: { text: string }) {
  return (
    <div className="jm-card rounded-2xl px-4 py-10 text-center">
      <p className="t-caption text-[13px] font-medium text-[#3c3c43]/45 dark:text-[#ebebf5]/45">{text}</p>
    </div>
  )
}

type Act = (url: string, payload: Record<string, unknown>) => Promise<void>

// ── ① 리뷰 승인 ─────────────────────────────────────────────────────────────
function ReviewsPanel({ reviews, act }: { reviews: Review[]; act: Act }) {
  if (!reviews.length) return <Empty text="처리할 리뷰가 없어요" />
  return (
    <ul className="space-y-2.5">
      {reviews.map((r) => {
        const shown = r.status === 'approved' // optimistic로 이미 떠 있는 것(포인트만 미확정)
        const held = r.status === 'held'
        return (
          <li key={r.id} className="jm-card rounded-2xl p-3.5">
            <div className="flex items-center gap-1.5">
              <span className="t-body truncate text-[13.5px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">{r.menu_name}</span>
              <span className="t-caption shrink-0 text-[11px] font-medium text-[#3c3c43]/45 dark:text-[#ebebf5]/45">· {r.store_name}</span>
              <span className="ml-auto shrink-0" />
              {r.reason && (
                <span className="t-caption shrink-0 rounded-full bg-[#ff3b30]/12 px-2 py-0.5 text-[10.5px] font-bold text-[#ff3b30]">
                  {REASON[r.reason] ?? r.reason}
                </span>
              )}
              <span className={`t-caption shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
                shown ? 'bg-[#ff7a18]/12 text-[#ff7a18]' : 'bg-black/[0.05] text-[#3c3c43]/55 dark:bg-white/[0.09] dark:text-[#ebebf5]/55'
              }`}>
                {shown ? '노출 중·포인트 미확정' : held ? '보류' : '대기'}
              </span>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {r.rating != null && (
                <span className="t-price text-[12px] font-bold text-[#ff7a18]">
                  {'★'.repeat(r.rating)}<span className="text-[#3c3c43]/20 dark:text-[#ebebf5]/20">{'★'.repeat(5 - r.rating)}</span>
                </span>
              )}
              {r.tags.map((t) => (
                <span key={t} className="t-caption rounded-full bg-black/[0.05] px-1.5 py-0.5 text-[10.5px] font-medium text-[#3c3c43]/65 dark:bg-white/[0.09] dark:text-[#ebebf5]/65">{t}</span>
              ))}
              <span className="t-caption ml-auto text-[10px] font-medium text-[#3c3c43]/40 dark:text-[#ebebf5]/40">{ago(r.created_at)}</span>
            </div>

            {r.comment && (
              <p className="t-body mt-1.5 rounded-xl bg-black/[0.03] px-3 py-2 text-[13px] text-[#1c1c1e] dark:bg-white/[0.05] dark:text-[#f2f2f7]">{r.comment}</p>
            )}

            <div className="mt-2.5 flex gap-2">
              <button
                onClick={() => act('/api/admin/moderation', { action: 'approve', reviewId: r.id })}
                className="jm-press t-caption flex-1 rounded-xl bg-[#ff7a18] py-2 text-[12.5px] font-semibold text-white"
              >
                {shown ? '+10P 확정' : '승인 · +10P'}
              </button>
              <button
                onClick={() => act('/api/admin/moderation', { action: 'hold', reviewId: r.id })}
                className="jm-press t-caption rounded-xl bg-[#ffcc00]/15 px-3 py-2 text-[12.5px] font-semibold text-[#9a6b00] dark:text-[#ffd60a]"
              >
                보류
              </button>
              <button
                onClick={() => act('/api/admin/moderation', { action: 'reject', reviewId: r.id })}
                className="jm-press t-caption flex-1 rounded-xl bg-black/[0.05] py-2 text-[12.5px] font-semibold text-[#3c3c43]/70 dark:bg-white/[0.09] dark:text-[#ebebf5]/70"
              >
                {shown ? '내리기' : '거부'}
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// ── ② 가격 제보 ─────────────────────────────────────────────────────────────
function ReportsPanel({ reports, act }: { reports: Report[]; act: Act }) {
  if (!reports.length) return <Empty text="처리할 제보가 없어요" />
  return (
    <ul className="space-y-2.5">
      {reports.map((r) => (
        <li key={r.id} className="jm-card rounded-2xl p-3.5">
          <div className="flex items-center gap-1.5">
            <span className="t-body truncate text-[13.5px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">{r.menu_name}</span>
            <span className="t-caption truncate text-[11px] font-medium text-[#3c3c43]/45 dark:text-[#ebebf5]/45">· {r.store_name}</span>
              <span className="t-caption ml-auto shrink-0 text-[10px] font-medium text-[#3c3c43]/40 dark:text-[#ebebf5]/40">{ago(r.created_at)}</span>
            </div>

            {r.status === 'held' && (
              <span className="t-caption mt-1.5 inline-block rounded-full bg-[#ffcc00]/15 px-2 py-0.5 text-[10.5px] font-semibold text-[#9a6b00] dark:text-[#ffd60a]">보류</span>
            )}

            <div className="mt-2 flex items-center gap-2">
            {r.kind === 'price_changed' && r.reported_price != null ? (
              <p className="t-price text-[15px] font-bold text-[#1c1c1e] dark:text-[#f2f2f7]">
                <span className="text-[#3c3c43]/45 line-through dark:text-[#ebebf5]/45">{r.current_price.toLocaleString()}</span>
                <span className="mx-1.5 text-[#ff7a18]">→</span>
                {r.reported_price.toLocaleString()}<span className="ml-0.5 text-[11px] font-medium text-[#3c3c43]/50 dark:text-[#ebebf5]/50">원</span>
              </p>
            ) : r.kind === 'discontinued' || r.kind === 'sold_out' ? (
              <span className="t-caption rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] font-semibold text-[#3c3c43]/65 dark:bg-white/[0.09] dark:text-[#ebebf5]/65">단종 요청</span>
            ) : r.kind === 'store_gone' ? (
              <span className="t-caption rounded-full bg-[#ff3b30]/12 px-2 py-0.5 text-[11px] font-semibold text-[#c9241a] dark:text-[#ff453a]">가게 폐업 요청</span>
            ) : (
              <span className="t-caption rounded-full bg-[#34c759]/12 px-2 py-0.5 text-[11px] font-semibold text-[#248a3d] dark:text-[#30d158]">
                {r.kind === 'price_ok' ? '가격 맞음 확인' : '계속 판매 확인'}
              </span>
            )}
          </div>

          <div className="mt-2.5 flex gap-2">
            <button
              onClick={() => act('/api/admin/reports', { id: r.id, action: 'approve' })}
              className="jm-press t-caption flex-1 rounded-xl bg-[#ff7a18] py-2 text-[12.5px] font-semibold text-white"
            >
              승인 · {r.points_awarded
                ? '반영(포인트 기지급)'
                : r.kind === 'price_changed' || r.kind === 'discontinued' || r.kind === 'sold_out'
                  ? '반영·+20P'
                  : '+5P'}
            </button>
            <button
              onClick={() => act('/api/admin/reports', { id: r.id, action: 'hold' })}
              className="jm-press t-caption rounded-xl bg-[#ffcc00]/15 px-3 py-2 text-[12.5px] font-semibold text-[#9a6b00] dark:text-[#ffd60a]"
            >
              보류
            </button>
            <button
              onClick={() => act('/api/admin/reports', { id: r.id, action: 'reject' })}
              className="jm-press t-caption flex-1 rounded-xl bg-black/[0.05] py-2 text-[12.5px] font-semibold text-[#3c3c43]/70 dark:bg-white/[0.09] dark:text-[#ebebf5]/70"
            >
              거부
            </button>
          </div>
        </li>
      ))}
    </ul>
  )
}

// ── ③ 자동 수집 변경 후보 + 통합 이력 ─────────────────────────────────────────
function ChangesPanel({
  changes, recent, runs, act,
}: {
  changes: ChangeItem[]; recent: ChangeItem[]; runs: IngestRun[]; act: Act
}) {
  return (
    <>
      <p className="t-caption mb-2 px-1 text-[12px] font-semibold text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
        확인할 변경 {changes.length}
      </p>
      {changes.length === 0 ? <Empty text="확인할 자동 변경이 없어요" /> : (
        <ul className="space-y-2.5">
          {changes.map((c) => (
            <li key={c.id} className="jm-card rounded-2xl p-3.5">
              <div className="flex items-center gap-1.5">
                <span className="t-caption rounded-full bg-[#ff7a18]/12 px-2 py-0.5 text-[10.5px] font-bold text-[#ff7a18]">
                  {c.entity_type === 'menu' ? '메뉴' : '가게'}
                </span>
                {c.status === 'held' && (
                  <span className="t-caption rounded-full bg-[#ffcc00]/15 px-2 py-0.5 text-[10.5px] font-semibold text-[#9a6b00] dark:text-[#ffd60a]">보류</span>
                )}
                <span className="t-caption ml-auto text-[10px] font-medium text-[#3c3c43]/40 dark:text-[#ebebf5]/40">{ago(c.detected_at)}</span>
              </div>
              <p className="t-body mt-1.5 text-[13.5px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">{c.summary}</p>
              <p className="t-caption mt-0.5 text-[10.5px] font-medium text-[#3c3c43]/45 dark:text-[#ebebf5]/45">
                최초 감지 {new Date(c.detected_at).toLocaleString('ko-KR')} · {c.source}
              </p>
              <div className="mt-2.5 flex gap-2">
                <button
                  onClick={() => act('/api/admin/changes', { id: c.id, action: 'approve' })}
                  className="jm-press t-caption flex-1 rounded-xl bg-[#ff7a18] py-2 text-[12.5px] font-semibold text-white"
                >
                  승인 · 반영
                </button>
                <button
                  onClick={() => act('/api/admin/changes', { id: c.id, action: 'hold' })}
                  className="jm-press t-caption rounded-xl bg-[#ffcc00]/15 px-3 py-2 text-[12.5px] font-semibold text-[#9a6b00] dark:text-[#ffd60a]"
                >
                  보류
                </button>
                <button
                  onClick={() => act('/api/admin/changes', { id: c.id, action: 'reject' })}
                  className="jm-press t-caption flex-1 rounded-xl bg-black/[0.05] py-2 text-[12.5px] font-semibold text-[#3c3c43]/70 dark:bg-white/[0.09] dark:text-[#ebebf5]/70"
                >
                  거부
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="t-caption mb-2 mt-6 px-1 text-[12px] font-semibold text-[#3c3c43]/55 dark:text-[#ebebf5]/55">최근 확정 기록</p>
      {recent.length === 0 ? <Empty text="아직 변경 기록이 없어요" /> : (
        <ul className="space-y-1.5">
          {recent.slice(0, 50).map((c) => (
            <li key={c.id} className="jm-card rounded-2xl px-3.5 py-3">
              <div className="flex items-start gap-2">
                <p className="t-body min-w-0 flex-1 text-[12.5px] font-medium text-[#1c1c1e] dark:text-[#f2f2f7]">{c.summary}</p>
                <span className={`t-caption shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  c.status === 'confirmed'
                    ? 'bg-[#34c759]/12 text-[#248a3d] dark:text-[#30d158]'
                    : 'bg-black/[0.05] text-[#3c3c43]/50 dark:bg-white/[0.09] dark:text-[#ebebf5]/50'
                }`}>{c.status === 'confirmed' ? '확정' : '거부'}</span>
              </div>
              <p className="t-caption mt-1 text-[10px] font-medium text-[#3c3c43]/40 dark:text-[#ebebf5]/40">
                {new Date(c.confirmed_at ?? c.reviewed_at ?? c.detected_at).toLocaleString('ko-KR')} · {c.source}
              </p>
            </li>
          ))}
        </ul>
      )}

      <p className="t-caption mb-2 mt-6 px-1 text-[12px] font-semibold text-[#3c3c43]/55 dark:text-[#ebebf5]/55">최근 수집 실행</p>
      {runs.length === 0 ? <Empty text="수집 실행 기록이 없어요" /> : (
        <ul className="space-y-1.5">
          {runs.map((r) => (
            <li key={r.id} className="jm-card rounded-2xl px-3.5 py-3">
              <div className="flex items-center gap-2">
                <span className="t-body text-[12.5px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">{r.source} · {r.scope}</span>
                <span className={`t-caption ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  r.status === 'completed' ? 'bg-[#34c759]/12 text-[#248a3d] dark:text-[#30d158]' : r.status === 'failed' ? 'bg-[#ff3b30]/12 text-[#ff3b30]' : 'bg-black/[0.05] text-[#3c3c43]/50 dark:bg-white/[0.09]'
                }`}>{r.status === 'completed' ? '완료' : r.status === 'failed' ? '실패' : '실행 중'}</span>
              </div>
              <p className="t-caption mt-0.5 text-[10.5px] font-medium text-[#3c3c43]/45 dark:text-[#ebebf5]/45">
                {r.records_seen.toLocaleString()}건 확인 · 변경 기록 {r.changes_detected} · {ago(r.started_at)}
              </p>
              {r.error_text && <p className="t-caption mt-1 break-all text-[10.5px] font-medium text-[#ff3b30]">{r.error_text}</p>}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

// ── ④ 포인트 지급 원장 ───────────────────────────────────────────────────────
function PointsPanel({ entries }: { entries: PointEntry[] }) {
  if (!entries.length) return <Empty text="아직 포인트 지급 기록이 없어요" />
  const LABEL: Record<string, string> = {
    opening_balance: '기존 잔액 이관',
    review_approved: '리뷰 승인',
    'verification:store_gone': '가게 폐업 제보',
    'verification:price_ok': '가격 확인',
    'verification:still_selling': '판매 확인',
    'verification:price_changed': '가격 변경 제보',
    'verification:discontinued': '단종 제보',
    'verification:sold_out': '구버전 품절 제보',
    legacy_verification_immediate: '구버전 제보 즉시 지급',
    legacy_review_immediate: '구버전 리뷰 즉시 지급',
    direct_points_adjustment: '직접 포인트 조정',
  }
  return (
    <ul className="space-y-2">
      {entries.map((p) => (
        <li key={p.id} className="jm-card flex items-center gap-3 rounded-2xl px-3.5 py-3">
          <div className="min-w-0 flex-1">
            <p className="t-body text-[12.5px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">{LABEL[p.reason] ?? p.reason}</p>
            <p className="t-price mt-0.5 text-[10.5px] font-medium text-[#3c3c43]/45 dark:text-[#ebebf5]/45">
              기기 {p.user_id.slice(0, 8)}… · 잔액 {p.balance_after.toLocaleString()}P · {ago(p.created_at)}
            </p>
            {p.reference_id && (
              <p className="t-price mt-0.5 text-[9.5px] font-medium text-[#3c3c43]/35 dark:text-[#ebebf5]/35">
                {p.reference_type ?? '대상'} {p.reference_id.slice(0, 8)}…
              </p>
            )}
          </div>
          <span className={`t-price shrink-0 text-[14px] font-bold ${p.amount > 0 ? 'text-[#ff7a18]' : 'text-[#ff3b30]'}`}>
            {p.amount > 0 ? '+' : ''}{p.amount}P
          </span>
        </li>
      ))}
    </ul>
  )
}

// ── ⑤ 기기 ──────────────────────────────────────────────────────────────────
function DevicesPanel({ devices, act }: { devices: Device[]; act: Act }) {
  if (!devices.length) return <Empty text="검열에 걸리거나 차단된 기기가 없어요" />
  return (
    <ul className="space-y-2.5">
      {devices.map((d) => (
        <li key={d.id} className="jm-card flex items-center gap-3 rounded-2xl p-3.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="t-price truncate text-[12.5px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">{d.id.slice(0, 8)}…</span>
              {d.blocked_at
                ? <span className="t-caption shrink-0 rounded-full bg-[#ff3b30]/12 px-2 py-0.5 text-[10.5px] font-bold text-[#ff3b30]">차단됨</span>
                : <span className="t-caption shrink-0 rounded-full bg-[#ff7a18]/12 px-2 py-0.5 text-[10.5px] font-bold text-[#ff7a18]">감지 {d.flag_count}</span>}
            </div>
            <p className="t-caption mt-0.5 text-[11px] font-medium text-[#3c3c43]/50 dark:text-[#ebebf5]/50">
              {d.last_reason ? `최근 ${REASON[d.last_reason] ?? d.last_reason}` : '기록 없음'} · {ago(d.last_at)}
            </p>
          </div>
          {d.blocked_at ? (
            <button
              onClick={() => act('/api/admin/moderation', { action: 'unblock', userId: d.id })}
              className="jm-press t-caption shrink-0 rounded-xl bg-black/[0.05] px-3.5 py-2 text-[12px] font-semibold text-[#3c3c43]/70 dark:bg-white/[0.09] dark:text-[#ebebf5]/70"
            >
              차단 해제
            </button>
          ) : (
            <button
              onClick={() => act('/api/admin/moderation', { action: 'block', userId: d.id })}
              className="jm-press t-caption shrink-0 rounded-xl bg-[#ff3b30] px-4 py-2 text-[12px] font-semibold text-white"
            >
              차단
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

// ── 감지 로그 ────────────────────────────────────────────────────────────────
// 규칙·AI가 막은 것(채팅 포함)을 열람한다. 오탐 파악 + 반복범 기기 차단용.
function BlocksPanel({ blocks, act }: { blocks: Block[]; act: Act }) {
  if (!blocks.length) return <Empty text="최근 감지 기록이 없어요" />
  return (
    <ul className="space-y-2">
      {blocks.map((b) => (
        <li key={b.id} className="jm-card rounded-2xl p-3.5">
          <div className="flex items-center gap-1.5">
            {b.reason && (
              <span className="t-caption shrink-0 rounded-full bg-[#ff3b30]/12 px-2 py-0.5 text-[10.5px] font-bold text-[#ff3b30]">
                {REASON[b.reason] ?? b.reason}
              </span>
            )}
            <span className="t-caption shrink-0 rounded-full bg-black/[0.05] px-2 py-0.5 text-[10.5px] font-semibold text-[#3c3c43]/60 dark:bg-white/[0.09] dark:text-[#ebebf5]/60">
              {KIND[b.target_kind] ?? b.target_kind}
            </span>
            <span className="t-caption ml-auto shrink-0 text-[10px] font-medium text-[#3c3c43]/40 dark:text-[#ebebf5]/40">{ago(b.created_at)}</span>
          </div>
          {b.comment_norm && (
            <p className="t-body mt-1.5 break-all rounded-xl bg-black/[0.03] px-3 py-2 text-[12.5px] text-[#1c1c1e] dark:bg-white/[0.05] dark:text-[#f2f2f7]">
              {b.comment_norm}
            </p>
          )}
          {b.user_id && (
            <div className="mt-2 flex items-center gap-2">
              <span className="t-price text-[11px] font-medium text-[#3c3c43]/45 dark:text-[#ebebf5]/45">{b.user_id.slice(0, 8)}…</span>
              <button
                onClick={() => act('/api/admin/moderation', { action: 'block', userId: b.user_id })}
                className="jm-press t-caption ml-auto shrink-0 rounded-lg bg-[#ff3b30]/10 px-3 py-1.5 text-[11px] font-semibold text-[#ff3b30]"
              >
                이 기기 차단
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

// ── ④ 가게 관리 (메뉴 채우기 + 리뷰 내리기) ──────────────────────────────────
// 가게를 검색해 선택하면 (1) 대표 메뉴를 붙이고 (2) 그 가게의 리뷰를 보고 유해한 걸
// 내릴 수 있다. 리뷰 내리기는 여기서만 가능하다 — 대기열(리뷰 탭)엔 '미확정'만 뜨고,
// 이미 노출·확정된 리뷰(사후 신고·명예훼손)는 가게로 찾아 들어와야 뺄 수 있다.
function MenusPanel({ onAuthLost }: { onAuthLost: () => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<StoreHit[]>([])
  const [selected, setSelected] = useState<StoreHit | null>(null)
  const [rows, setRows] = useState<{ name: string; price: string }[]>([{ name: '', price: '' }, { name: '', price: '' }, { name: '', price: '' }])
  const [reviews, setReviews] = useState<StoreReview[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 가게 상세(리뷰 포함)를 불러온다. 내리기 후에도 다시 불러 화면을 서버와 맞춘다.
  const loadStore = async (id: string) => {
    try {
      const r = await fetch(`/api/admin/store?id=${id}`)
      if (r.status === 401) { onAuthLost(); return }
      const d = await r.json()
      setReviews(d.reviews ?? [])
    } catch { /* 리뷰가 안 떠도 메뉴 채우기는 된다 */ }
  }

  const pick = (s: StoreHit) => { setSelected(s); setMsg(null); setReviews([]); loadStore(s.id) }

  const search = async (e: React.FormEvent) => {
    e.preventDefault()
    if (q.trim().length < 2) return
    setBusy(true)
    try {
      const r = await fetch(`/api/admin/search?q=${encodeURIComponent(q.trim())}`)
      if (r.status === 401) { onAuthLost(); return }
      const d = await r.json()
      setResults(d.stores ?? []); setSelected(null); setReviews([]); setMsg(null)
    } finally { setBusy(false) }
  }

  const save = async () => {
    if (!selected) return
    const menus = rows
      .filter((r) => r.name.trim() && r.price.trim())
      .map((r) => ({ name: r.name.trim(), price: parseInt(r.price.replace(/[^0-9]/g, ''), 10) }))
    if (!menus.length) { setMsg('메뉴를 입력하세요'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/admin/menus', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId: selected.id, menus }),
      })
      if (res.status === 401) { onAuthLost(); return }
      const d = await res.json()
      if (!res.ok) { setMsg(d.error); return }
      setMsg(`저장 완료 — ${selected.name}에 메뉴 ${d.menus.length}개`)
      setRows([{ name: '', price: '' }, { name: '', price: '' }, { name: '', price: '' }])
      setResults((prev) => prev.map((s) => (s.id === selected.id ? { ...s, menu_count: d.menus.length } : s)))
    } finally { setBusy(false) }
  }

  // 리뷰 내리기 — 이미 노출·확정된 것도 뺀다(엔드포인트가 지원). 지급된 포인트는 회수 안 함.
  const takedown = async (reviewId: string) => {
    const res = await fetch('/api/admin/moderation', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reject', reviewId }),
    })
    if (res.status === 401) { onAuthLost(); return }
    if (selected) loadStore(selected.id)
  }

  return (
    <>
      <form onSubmit={search} className="flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="가게명 또는 주소 (2글자 이상)" className={INPUT} />
        <button disabled={busy} className="jm-press t-caption shrink-0 rounded-xl bg-[#1c1c1e] px-4 text-[13px] font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-[#1c1c1e]">
          검색
        </button>
      </form>

      {results.length > 0 && !selected && (
        <ul className="mt-3 space-y-1.5">
          {results.map((s) => (
            <li key={s.id}>
              <button onClick={() => pick(s)} className="jm-card jm-press block w-full rounded-2xl px-4 py-3 text-left">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="t-body truncate text-[14px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">{s.name}</span>
                  <span className="t-caption shrink-0 text-[11px] font-medium text-[#3c3c43]/50 dark:text-[#ebebf5]/50">{s.category} · 메뉴 {s.menu_count}</span>
                </div>
                <p className="t-caption truncate text-[11.5px] font-medium text-[#3c3c43]/45 dark:text-[#ebebf5]/45">{s.road_address}</p>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="jm-card mt-3 rounded-2xl p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="t-body truncate text-[14px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">{selected.name}</p>
              <p className="t-caption truncate text-[11.5px] font-medium text-[#3c3c43]/45 dark:text-[#ebebf5]/45">{selected.road_address}</p>
            </div>
            <button onClick={() => { setSelected(null); setReviews([]) }} className="jm-press t-caption shrink-0 text-[11.5px] font-semibold text-[#ff7a18]">다른 가게</button>
          </div>

          <div className="mt-3.5 space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="flex gap-2">
                <input value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder={`메뉴 ${i + 1}`} className={INPUT} />
                <input value={r.price} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} placeholder="가격" inputMode="numeric" className={`${INPUT} w-28 shrink-0`} />
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button onClick={() => setRows([...rows, { name: '', price: '' }])} className="jm-press t-caption text-[12px] font-semibold text-[#ff7a18]">메뉴 추가</button>
            <button onClick={save} disabled={busy} className="jm-press t-caption ml-auto rounded-xl bg-[#1c1c1e] px-5 py-2 text-[13px] font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-[#1c1c1e]">저장</button>
          </div>
        </div>
      )}

      {msg && (
        <p className="t-caption mt-3 rounded-xl bg-black/[0.04] px-4 py-2.5 text-[12.5px] font-medium text-[#3c3c43]/70 dark:bg-white/[0.06] dark:text-[#ebebf5]/70">{msg}</p>
      )}

      {/* 이 가게 리뷰 — 유해한 걸 찾아 내린다. 노출 중·대기·내려감을 상태로 구분해서 보여준다. */}
      {selected && reviews.length > 0 && (
        <div className="mt-4">
          <p className="t-caption mb-2 px-1 text-[12px] font-semibold text-[#3c3c43]/55 dark:text-[#ebebf5]/55">이 가게 리뷰 {reviews.length}</p>
          <ul className="space-y-2">
            {reviews.map((r) => {
              const down = r.status === 'rejected'
              return (
                <li key={r.id} className="jm-card rounded-2xl p-3">
                  <div className="flex items-center gap-1.5">
                    <span className="t-caption truncate text-[11.5px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">{r.menu_name}</span>
                    {r.rating != null && <span className="t-price shrink-0 text-[11px] font-bold text-[#ff7a18]">{'★'.repeat(r.rating)}</span>}
                    <span className="t-caption ml-auto shrink-0 text-[10px] font-medium text-[#3c3c43]/40 dark:text-[#ebebf5]/40">{ago(r.created_at)}</span>
                  </div>
                  {r.comment && <p className="t-body mt-1 text-[12.5px] text-[#1c1c1e] dark:text-[#f2f2f7]">{r.comment}</p>}
                  <div className="mt-2 flex items-center gap-1.5">
                    <span className={`t-caption rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      down
                        ? 'bg-black/[0.05] text-[#3c3c43]/45 dark:bg-white/[0.09] dark:text-[#ebebf5]/45'
                        : r.status === 'pending'
                          ? 'bg-black/[0.05] text-[#3c3c43]/55 dark:bg-white/[0.09] dark:text-[#ebebf5]/55'
                          : 'bg-[#ff7a18]/12 text-[#ff7a18]'
                    }`}>
                      {down ? '내려감' : r.status === 'pending' ? '대기' : '노출 중'}
                    </span>
                    {r.reason && <span className="t-caption rounded-full bg-[#ff3b30]/12 px-2 py-0.5 text-[10px] font-bold text-[#ff3b30]">{REASON[r.reason] ?? r.reason}</span>}
                    {!down && (
                      <button onClick={() => takedown(r.id)} className="jm-press t-caption ml-auto shrink-0 rounded-lg bg-[#ff3b30]/10 px-3 py-1.5 text-[11px] font-semibold text-[#ff3b30]">내리기</button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <div className="mt-8 rounded-2xl border border-[#ff7a18]/25 bg-[#ff7a18]/[0.06] p-4">
        <p className="t-caption text-[11.5px] font-bold text-[#c2410c] dark:text-[#ff9a4a]">자동 수집 범위</p>
        <p className="t-body mt-1.5 text-[11.5px] leading-relaxed text-[#3c3c43]/70 dark:text-[#ebebf5]/70">
          메뉴 자동 갱신은 이용허락을 확인한 공공데이터 범위로 제한한다. 네이버·카카오의 리뷰·사진·설명은
          가져오지 않는다. 수집기가 찾은 가격·단종·폐업 차이는 확정값을 바로 덮지 않고 변경 탭에서 확인한 뒤 반영한다.
        </p>
      </div>
    </>
  )
}
