'use client'

import { useEffect, useRef, useState } from 'react'
import { animate } from 'motion'
import { sheetEnterKeyframes } from '@/lib/layout'
import { distanceMeters, walkMinutes } from '@/lib/coords'

// 길찾기 라이트박스 — 앱을 벗어나지 않게 앱 안 팝업으로 띄운다.
//
//   · 데스크탑: 카카오 웹지도를 iframe으로 그대로 띄운다(동작함).
//   · 모바일: 카카오가 모바일 링크를 applink 페이지로 리다이렉트하며 X-Frame-Options로
//     iframe을 막는다(빈 팝업이 됨). 그래서 지도를 우리가 그리지 않고 — 실제 길찾기·지도·
//     위치기반서비스는 카카오에 맡기는 게 맞다 — 대신 '카카오맵으로 길찾기' 카드를 앱 안에
//     띄우고, 버튼을 눌러야 카카오 앱/웹으로 넘어간다(새 탭으로 자동으로 휙 넘어가지 않게).
//
// 좌표는 우리가 가진 WGS84 그대로 /link/from/…/to/… 스킴에 넣는다(검증한 포맷).

type Dest = { lat: number; lng: number; name: string }
type LatLng = { lat: number; lng: number }

function routeUrl(dest: Dest, origin: LatLng | null): string {
  const to = `${encodeURIComponent(dest.name)},${dest.lat},${dest.lng}`
  return origin
    ? `https://map.kakao.com/link/from/${encodeURIComponent('내 위치')},${origin.lat},${origin.lng}/to/${to}`
    : `https://map.kakao.com/link/to/${to}`
}

function distanceLabel(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`
}

/** 새 창(외부 링크) 화살표 */
function OpenIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 17L17 7M17 7H8M17 7v9" />
    </svg>
  )
}

export default function DirectionsLightbox({
  dest, userLocation, onClose, onLocated,
}: {
  dest: Dest
  userLocation: LatLng | null
  onClose: () => void
  /** 여기(데스크탑)서 처음 잡은 내 위치를 부모에 알려 다음부터 바로 쓰게 한다. */
  onLocated: (loc: LatLng) => void
}) {
  // 모바일(터치)이면 카드, 아니면 카카오 iframe.
  const [coarse] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)
  const [url, setUrl] = useState<string | null>(userLocation ? routeUrl(dest, userLocation) : null)
  const panelRef = useRef<HTMLDivElement>(null)

  // 슬라이드 인 — 하단이면 아래에서, 우측 패널이면 옆에서
  useEffect(() => {
    const el = panelRef.current
    if (el && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      animate(el, { transform: sheetEnterKeyframes() }, { type: 'spring', bounce: 0, duration: 0.42 })
    }
  }, [])

  // 데스크탑 iframe의 출발지를 채우려고 내 위치를 1회 조회한다. 모바일 카드는 위치 없이도
  // 열리고(카카오가 현재 위치를 잡음) 지도를 안 그리므로 여기선 조회하지 않는다.
  //
  // 조회는 진입 애니메이션이 끝난 뒤로 미룬다 — 권한 프롬프트가 rAF를 멈춰 화면 밖에서
  // 시작하는 진입 애니메이션을 얼려버리기 때문(모바일 관련이지만 데스크탑에도 무해).
  useEffect(() => {
    if (coarse || userLocation || !navigator.geolocation) return
    let alive = true
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = setTimeout(() => {
      if (!alive) return
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
    }, reduced ? 0 : 460)
    return () => { alive = false; clearTimeout(timer) }
  }, [coarse, dest, userLocation, onLocated])

  const openUrl = url ?? routeUrl(dest, userLocation)
  const walkM = userLocation ? distanceMeters(userLocation, dest) : null

  return (
    <>
      <button aria-label="닫기" onClick={onClose} className="jm-scrim absolute inset-0 z-[1390]" />

      {/* 좌우 여백 라운드 카드. 모바일은 하단 카드(내용 높이), 데스크탑/넓은 화면은
          꽉 찬 높이(카카오 iframe이 들어가므로). 넓은 화면에선 오른쪽에 세운다. */}
      <div
        ref={panelRef}
        className="jm-card absolute inset-x-3 z-[1400] flex flex-col overflow-hidden rounded-[26px] will-change-transform jm-side-card side:w-[400px] side:max-w-[86vw]"
        style={
          coarse
            ? { bottom: 'max(env(safe-area-inset-bottom), 16px)' }
            : { top: 'max(env(safe-area-inset-top), 16px)', bottom: 'max(env(safe-area-inset-bottom), 16px)' }
        }
      >
        {/* 헤더 */}
        <div className="flex items-center gap-2 px-3 py-2.5">
          <p className="t-title flex-1 truncate text-[15px] font-bold text-[#1c1c1e] dark:text-[#f2f2f7]">
            {dest.name} 길찾기
          </p>
          {/* 데스크탑은 헤더에 외부 링크(모바일은 아래 큰 버튼으로 대체) */}
          {!coarse && (
            <a
              href={openUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="jm-press t-caption flex shrink-0 items-center gap-1 rounded-full bg-black/[0.05] px-3 py-1.5 text-[12px] font-semibold text-[#3c3c43]/70 dark:bg-white/[0.09] dark:text-[#ebebf5]/70"
            >
              카카오맵에서 열기
              <OpenIcon className="size-3" />
            </a>
          )}
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

        {coarse ? (
          /* 모바일 — 카드. 버튼을 눌러야 카카오로 넘어간다. */
          <div className="flex flex-col gap-2.5 px-4 pb-4 pt-0.5">
            <p className="t-caption text-center text-[12.5px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
              {walkM != null
                ? `내 위치에서 직선 ${distanceLabel(walkM)} · 도보 약 ${walkMinutes(walkM)}분`
                : '카카오맵에서 현재 위치 기준으로 길안내해요'}
            </p>
            <a
              href={openUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="jm-press t-caption flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#ff7a18] py-3 text-[13px] font-semibold text-white"
            >
              카카오맵으로 길찾기
              <OpenIcon className="size-3.5" />
            </a>
            <p className="t-caption text-center text-[10.5px] font-medium text-[#3c3c43]/40 dark:text-[#ebebf5]/40">
              카카오맵 앱(설치 시) 또는 웹에서 열려요
            </p>
          </div>
        ) : (
          /* 데스크탑 — 카카오 웹지도 iframe */
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
        )}
      </div>
    </>
  )
}
