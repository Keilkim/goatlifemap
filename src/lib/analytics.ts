'use client'

// 행동 로그 클라이언트.
// 이벤트마다 요청을 날리면 지도 조작 중 네트워크가 시끄러워지므로 큐에 모아 보낸다.
// 페이지를 떠날 때 남은 큐는 sendBeacon으로 보낸다 — beforeunload에서 fetch는 취소되지만
// sendBeacon은 브라우저가 배달을 보장한다.

type QueuedEvent = { name: string; props?: Record<string, unknown> }

let userId: string | null = null
let sessionId: string | null = null
let queue: QueuedEvent[] = []
let timer: ReturnType<typeof setTimeout> | null = null

export function initAnalytics(uid: string, sid: string) {
  userId = uid
  sessionId = sid
}

function flush(useBeacon = false) {
  if (!userId || queue.length === 0) return
  const payload = JSON.stringify({ userId, sessionId, events: queue.slice(0, 50) })
  queue = []
  if (timer) { clearTimeout(timer); timer = null }

  if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon('/api/events', new Blob([payload], { type: 'application/json' }))
  } else {
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => { /* 로그 실패가 사용자 경험을 막으면 안 된다 */ })
  }
}

export function track(name: string, props?: Record<string, unknown>) {
  queue.push({ name, props })
  if (queue.length >= 20) return flush()
  if (!timer) timer = setTimeout(() => flush(), 3000)
}

if (typeof window !== 'undefined') {
  // visibilitychange가 beforeunload보다 신뢰할 수 있다.
  // 모바일에서 탭 전환/홈 이동은 beforeunload를 발생시키지 않는 경우가 많다.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true)
  })
  window.addEventListener('pagehide', () => flush(true))
}

/** 보기별 체류시간 측정. 탭이 숨겨진 동안은 세지 않는다. */
export class DwellTimer {
  private start = Date.now()
  private accumulated = 0
  private active = true

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility)
    }
  }
  private onVisibility = () => {
    if (document.visibilityState === 'hidden') this.pause()
    else this.resume()
  }
  private pause() {
    if (!this.active) return
    this.accumulated += Date.now() - this.start
    this.active = false
  }
  private resume() {
    if (this.active) return
    this.start = Date.now()
    this.active = true
  }
  /** 지금까지의 체류시간(ms)을 돌려주고 타이머를 리셋한다. */
  lap(): number {
    const total = this.accumulated + (this.active ? Date.now() - this.start : 0)
    this.accumulated = 0
    this.start = Date.now()
    return total
  }
  dispose() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility)
    }
  }
}
