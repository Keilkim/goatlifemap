'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { animate } from 'motion'
import { sheetEnterKeyframes } from '@/lib/layout'

// 익명 실시간 채팅 창.
//
// 실시간은 폴링으로 흉내 낸다 — 열려 있는 동안 3초마다 "마지막 메시지 이후"만 가져온다.
// 로컬(자체 Postgres)에서도 그대로 돌고, 배포 뒤 Supabase Realtime으로 갈아탈 여지는 둔다.
//
// 방어는 서버가 한다. 링크·연락처·욕설·음란은 서버에서 거절되고, 여기선 그 사유만 보여준다.

type Msg = { id: string; nick: string; body: string; created_at: string; mine: boolean }

const POLL_MS = 3000
const CHAT_MAX = 100 // 화면·메모리엔 최신 100개만 (서버 보존 수와 같다)

function hhmm(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function ChatSheet({
  open, onClose, userId,
}: {
  open: boolean
  onClose: () => void
  userId: string | null
}) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const panelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const seen = useRef<Set<string>>(new Set())
  const lastTime = useRef<string | null>(null)

  // 마지막 메시지가 항상 보이도록 바닥으로 붙인다.
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // 새 메시지를 id로 중복 없이 이어붙인다. 폴링이 겹쳐도 안전하다.
  const merge = useCallback((incoming: Msg[]) => {
    const fresh = incoming.filter((m) => !seen.current.has(m.id))
    if (!fresh.length) return
    fresh.forEach((m) => seen.current.add(m.id))
    lastTime.current = fresh[fresh.length - 1].created_at
    // 최신 100개만 유지 — 오래 열어둬도 무한히 안 쌓이게. 잘려나간 건 위로 스스슥 사라진다.
    setMsgs((prev) => {
      const next = [...prev, ...fresh]
      return next.length > CHAT_MAX ? next.slice(-CHAT_MAX) : next
    })
  }, [])

  // 열릴 때 슬라이드 업 + 상태 초기화.
  useEffect(() => {
    if (!open) return
    seen.current = new Set()
    lastTime.current = null
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setMsgs([])
      setNotice(null)
    })

    const el = panelRef.current
    if (el && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // 하단 시트면 아래에서, 우측 패널이면 옆에서 슬라이드 인
      animate(el, { transform: sheetEnterKeyframes() }, { type: 'spring', bounce: 0, duration: 0.42 })
    }
    return () => { active = false }
  }, [open])

  // 폴링. 열려 있는 동안만.
  useEffect(() => {
    if (!open || !userId) return
    let alive = true

    const poll = async () => {
      const p = new URLSearchParams({ userId })
      if (lastTime.current) p.set('since', lastTime.current)
      try {
        const res = await fetch(`/api/chat?${p}`)
        const d: { messages?: Msg[] } = await res.json()
        if (!alive || !d.messages?.length) return
        const atBottom = (() => {
          const el = scrollRef.current
          return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80
        })()
        merge(d.messages)
        // 내가 바닥 근처를 보고 있을 때만 자동 스크롤 — 위를 읽는 중이면 방해하지 않는다
        if (atBottom) requestAnimationFrame(scrollToBottom)
      } catch { /* 잠깐 끊겨도 다음 폴링에서 복구된다 */ }
    }

    poll()
    const t = setInterval(poll, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [open, userId, merge, scrollToBottom])

  const send = async () => {
    const body = input.trim()
    if (!body || sending || !userId) return
    setSending(true)
    setNotice(null)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, body }),
      })
      const d = await res.json()
      if (res.ok && d.message) {
        merge([d.message])
        setInput('')
        requestAnimationFrame(scrollToBottom)
      } else {
        // 링크·욕설 등 서버가 막은 사유를 그대로 보여준다
        setNotice(d.error ?? '보낼 수 없어요')
      }
    } catch {
      setNotice('연결이 불안정해요')
    } finally {
      setSending(false)
    }
  }

  if (!open) return null

  return (
    <>
      <button aria-label="닫기" onClick={onClose} className="jm-scrim absolute inset-0 z-[1190]" />

      <div
        ref={panelRef}
        className="jm-sheet absolute inset-x-0 bottom-0 z-[1200] flex h-[78%] flex-col overflow-hidden rounded-t-[20px] will-change-transform jm-side-card side:h-auto side:w-[400px] side:max-w-[86vw] side:rounded-[24px]"
      >
        <div className="flex justify-center pb-1 pt-2">
          <span className="h-1 w-9 rounded-full bg-[#3c3c43]/20 dark:bg-[#ebebf5]/20" aria-hidden />
        </div>

        <div className="flex items-start gap-1.5 px-4 pb-2">
          <div className="min-w-0 flex-1">
            <p className="t-title truncate text-[16px] font-bold text-[#1c1c1e] dark:text-[#f2f2f7]">수다방</p>
            <p className="t-caption mt-px truncate text-[11.5px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
              익명 · 지금 여기 사람들과
            </p>
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

        {/* 메시지 목록. 상단을 그라데이션으로 흐려 오래된 메시지가 위로 스스슥 사라지게. */}
        <div
          ref={scrollRef}
          className="jm-scroll flex-1 space-y-2 overflow-y-auto overscroll-contain px-3 py-2"
          style={{
            maskImage: 'linear-gradient(to bottom, transparent 0, #000 52px)',
            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 52px)',
          }}
        >
          {msgs.length === 0 && (
            <p className="t-caption mt-8 text-center text-[12px] font-medium text-[#3c3c43]/40 dark:text-[#ebebf5]/40">
              아직 조용해요. 먼저 말 걸어보세요
            </p>
          )}
          {msgs.map((m) => (
            <div key={m.id} className={`flex flex-col ${m.mine ? 'items-end' : 'items-start'}`}>
              {!m.mine && (
                <span className="t-caption mb-0.5 px-1 text-[10.5px] font-medium text-[#3c3c43]/50 dark:text-[#ebebf5]/50">
                  {m.nick}
                </span>
              )}
              <div className="flex max-w-[78%] items-end gap-1">
                {m.mine && <span className="t-caption text-[9.5px] font-medium text-[#3c3c43]/35 dark:text-[#ebebf5]/35">{hhmm(m.created_at)}</span>}
                <p
                  className={`t-body whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-[13.5px] ${
                    m.mine
                      ? 'bg-[#ff7a18] text-white'
                      : 'bg-black/[0.05] text-[#1c1c1e] dark:bg-white/[0.09] dark:text-[#f2f2f7]'
                  }`}
                >
                  {m.body}
                </p>
                {!m.mine && <span className="t-caption text-[9.5px] font-medium text-[#3c3c43]/35 dark:text-[#ebebf5]/35">{hhmm(m.created_at)}</span>}
              </div>
            </div>
          ))}
        </div>

        {/* 서버가 막은 사유 */}
        {notice && (
          <p className="t-caption px-4 pb-1 text-center text-[11.5px] font-semibold text-[#ff3b30]">{notice}</p>
        )}

        {/* 입력 바 */}
        <div className="flex items-center gap-2 border-t border-[#3c3c43]/10 px-3 py-2.5 pb-[calc(env(safe-area-inset-bottom)+10px)] side:pb-2.5 dark:border-[#545458]/40">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }}
            maxLength={300}
            placeholder="메시지…"
            className="t-body min-w-0 flex-1 rounded-full bg-black/[0.05] px-4 py-2 text-[14px] text-[#1c1c1e] placeholder:text-[#3c3c43]/40 dark:bg-white/[0.09] dark:text-[#f2f2f7] dark:placeholder:text-[#ebebf5]/40"
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            aria-label="보내기"
            className="jm-press flex size-9 shrink-0 items-center justify-center rounded-full bg-[#ff7a18] text-white disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 12l16-8-6 16-3-6-7-2z" />
            </svg>
          </button>
        </div>
      </div>
    </>
  )
}
