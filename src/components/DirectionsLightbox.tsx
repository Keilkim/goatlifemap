'use client'

import { useEffect, useRef, useState } from 'react'
import { animate } from 'motion'
import { sheetEnterKeyframes } from '@/lib/layout'

// 길찾기 라이트박스.
//
// 새 탭으로 카카오맵을 열면 모바일에선 우리 앱으로 돌아오기가 번거롭다. 그래서 카카오
// 길찾기를 앱 안 팝업(iframe)으로 띄우고 '닫기' 한 번이면 지도로 복귀하게 한다.
//
// 좌표는 우리가 가진 WGS84 그대로 /link/from/…/to/… 스킴에 넣는다(검증한 포맷).
// 출발지는 내 위치를 자동으로 잡는다 — 이미 알면 즉시, 모르면 여기서 1회 조회한다.
//
// iframe이 안 뜨는 환경(카카오가 훗날 X-Frame-Options를 붙이거나, 모바일에서 앱으로
// 튕기는 경우)을 대비해 항상 '카카오맵에서 열기' 링크를 같이 둔다 — 막다른 길을 안 만든다.

type Dest = { lat: number; lng: number; name: string }

function routeUrl(dest: Dest, origin: { lat: number; lng: number } | null): string {
  const to = `${encodeURIComponent(dest.name)},${dest.lat},${dest.lng}`
  return origin
    ? `https://map.kakao.com/link/from/${encodeURIComponent('내 위치')},${origin.lat},${origin.lng}/to/${to}`
    : `https://map.kakao.com/link/to/${to}`
}

export default function DirectionsLightbox({
  dest, userLocation, onClose, onLocated,
}: {
  dest: Dest
  userLocation: { lat: number; lng: number } | null
  onClose: () => void
  /** 여기서 처음 잡은 내 위치를 부모에 알려 다음 길찾기부터 바로 쓰게 한다. */
  onLocated: (loc: { lat: number; lng: number }) => void
}) {
  const [url, setUrl] = useState<string | null>(userLocation ? routeUrl(dest, userLocation) : null)
  const panelRef = useRef<HTMLDivElement>(null)

  // 슬라이드 인 — 하단이면 아래에서, 우측 패널이면 옆에서
  useEffect(() => {
    const el = panelRef.current
    if (el && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      animate(el, { transform: sheetEnterKeyframes() }, { type: 'spring', bounce: 0, duration: 0.42 })
    }
  }, [])

  // 내 위치를 모르면 즉석 1회 조회. 실패하면 목적지만으로 연다.
  useEffect(() => {
    if (userLocation) return
    if (!navigator.geolocation) {
      let alive = true
      queueMicrotask(() => {
        if (alive) setUrl(routeUrl(dest, null))
      })
      return () => { alive = false }
    }
    let alive = true
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!alive) return
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        onLocated(loc)
        setUrl(routeUrl(dest, loc))
      },
      () => { if (alive) setUrl(routeUrl(dest, null)) }, // 거부/실패 → 목적지만
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 }
    )
    return () => { alive = false }
  }, [dest, userLocation, onLocated])

  // 폴백 링크는 위치를 아직 못 잡았어도 최소 목적지로는 열 수 있게 한다.
  const openUrl = url ?? routeUrl(dest, null)

  return (
    <>
      <button aria-label="닫기" onClick={onClose} className="jm-scrim absolute inset-0 z-[1390]" />

      {/* 꽉 채우지 않고 좌우·상하 여백을 준 라운드 카드(애플식). 스크림이 여백을 어둡게
          덮어 모달처럼 초점을 옮긴다. overflow-hidden으로 iframe 모서리까지 둥글게 자른다.
          넓은 화면(우측 패널 모드)에선 가로 전체 대신 오른쪽에 세워 지도를 함께 본다. */}
      <div
        ref={panelRef}
        className="jm-card absolute inset-x-3 z-[1400] flex flex-col overflow-hidden rounded-[26px] will-change-transform jm-side-card side:w-[400px] side:max-w-[86vw]"
        style={{ top: 'max(env(safe-area-inset-top), 16px)', bottom: 'max(env(safe-area-inset-bottom), 16px)' }}
      >
        {/* 헤더 */}
        <div className="flex items-center gap-2 px-3 py-2.5">
          <p className="t-title flex-1 truncate text-[15px] font-bold text-[#1c1c1e] dark:text-[#f2f2f7]">
            {dest.name} 길찾기
          </p>
          {/* 폴백 — iframe이 안 뜨거나 앱으로 열고 싶을 때 */}
          <a
            href={openUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="jm-press t-caption flex shrink-0 items-center gap-1 rounded-full bg-black/[0.05] px-3 py-1.5 text-[12px] font-semibold text-[#3c3c43]/70 dark:bg-white/[0.09] dark:text-[#ebebf5]/70"
          >
            카카오맵에서 열기
            <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 17L17 7M17 7H8M17 7v9" />
            </svg>
          </a>
          <button
            onClick={onClose}
            aria-label="닫기"
            className="jm-press flex size-8 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-[#3c3c43]/50 dark:bg-white/[0.09] dark:text-[#ebebf5]/50"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M7 7l10 10M17 7L7 17" />
            </svg>
          </button>
        </div>

        {/* 카카오 지도 — 위치 조회가 끝나면 iframe을 건다 */}
        <div className="relative flex-1 overflow-hidden">
          {url ? (
            <iframe
              src={url}
              title="카카오맵 길찾기"
              className="h-full w-full border-0"
              allow="geolocation"
            />
          ) : (
            <div className="grid h-full place-items-center">
              <p className="t-caption text-[12.5px] font-medium text-[#3c3c43]/45 dark:text-[#ebebf5]/45">내 위치 확인 중…</p>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
