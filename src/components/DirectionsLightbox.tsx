'use client'

import { useEffect, useRef, useState } from 'react'
import { animate } from 'motion'
import { sheetEnterKeyframes } from '@/lib/layout'
import { distanceMeters, walkMinutes } from '@/lib/coords'
import KakaoDirectionsMap from './KakaoDirectionsMap'

// 길찾기 라이트박스 — 앱을 벗어나지 않게 앱 안 팝업으로 띄운다.
//
//   · 데스크탑: 카카오 웹지도를 iframe으로 띄운다.
//   · 모바일: 카카오가 iframe을 막으므로, Kakao Maps JS SDK로 카카오 지도를 우리 DOM에 직접
//     렌더한다. 지도·타일·위치기반서비스는 카카오 제공.
//
// 팝업을 열면 내 위치를 자동으로 1회 잡아 '도보 약 N분'(직선 추정)과 내 위치 마커를 바로 보여준다.
// 정확한 경로/시간은 아래 '카카오맵으로 길찾기' 버튼이 카카오 앱을 열어 처리한다.

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
  /** 여기서 처음 잡은 내 위치를 부모에 알려 다음부터 바로 쓰게 한다. */
  onLocated: (loc: LatLng) => void
}) {
  // 모바일(터치)이면 카카오 SDK 지도, 아니면 카카오 iframe.
  const [coarse] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)
  const [url, setUrl] = useState<string | null>(userLocation ? routeUrl(dest, userLocation) : null)
  const [myLoc, setMyLoc] = useState<LatLng | null>(userLocation)
  const [locating, setLocating] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  // 슬라이드 인 — 하단이면 아래에서, 우측 패널이면 옆에서
  useEffect(() => {
    const el = panelRef.current
    if (el && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      animate(el, { transform: sheetEnterKeyframes() }, { type: 'spring', bounce: 0, duration: 0.42 })
    }
  }, [])

  // 내 위치를 모르면 자동으로 1회 조회 — 도보 시간·내 위치 마커·출발지를 채운다.
  // 조회는 진입 애니메이션이 끝난 뒤로 미룬다(권한 프롬프트가 rAF를 멈춰 진입 애니메이션을
  // 얼려버리기 때문).
  useEffect(() => {
    if (myLoc || !navigator.geolocation) return
    let alive = true
    setLocating(true)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = setTimeout(() => {
      if (!alive) return
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (!alive) return
          const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude }
          setMyLoc(loc)
          onLocated(loc)
          setUrl(routeUrl(dest, loc))
          setLocating(false)
        },
        () => { if (alive) { setUrl(routeUrl(dest, null)); setLocating(false) } },
        { enableHighAccuracy: false, timeout: 6000, maximumAge: 120000 }
      )
    }, reduced ? 0 : 460)
    return () => { alive = false; clearTimeout(timer) }
  }, [myLoc, dest, onLocated])

  const openUrl = url ?? routeUrl(dest, myLoc)
  const walkM = myLoc ? distanceMeters(myLoc, dest) : null

  return (
    <>
      <button aria-label="닫기" onClick={onClose} className="jm-scrim absolute inset-0 z-[1390]" />

      {/* 좌우·상하 여백 라운드 카드(애플식). 넓은 화면에선 오른쪽에 세운다. */}
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
          /* 모바일 — 카카오 SDK 지도 + 도보시간 + 실제 안내 버튼 */
          <>
            <div className="relative flex-1 overflow-hidden">
              <KakaoDirectionsMap dest={dest} origin={myLoc} />
            </div>
            <div className="flex flex-col gap-2 px-3 pb-3 pt-2">
              <p className="t-caption text-center text-[12.5px] font-medium text-[#3c3c43]/60 dark:text-[#ebebf5]/60">
                {walkM != null ? (
                  <>
                    <span className="font-bold text-[#1c1c1e] dark:text-[#f2f2f7]">도보 약 {walkMinutes(walkM)}분</span>
                    <span className="text-[#3c3c43]/45 dark:text-[#ebebf5]/45"> · 직선 {distanceLabel(walkM)}</span>
                  </>
                ) : locating ? (
                  '도보 시간 계산 중…'
                ) : (
                  '위치를 켜면 도보 시간이 표시돼요'
                )}
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
            </div>
          </>
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
