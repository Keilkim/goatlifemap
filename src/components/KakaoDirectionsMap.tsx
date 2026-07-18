'use client'

import { useEffect, useRef, useState } from 'react'

// 카카오 지도 팝업(모바일용).
//
// 카카오는 자기 지도가 남의 iframe에 박히는 걸 막지만, Kakao Maps JavaScript SDK는 우리
// 페이지 DOM에 지도를 '직접' 그려 그 제한을 받지 않는다. 지도·타일·위치기반서비스는 카카오가
// 제공한다. 실제 턴바이턴은 SDK 기본이 아니라(별도 유료 API) 목적지·내 위치 마커와 직선만 그리고,
// 실제 길안내는 팝업 아래 '카카오맵으로 길찾기' 버튼이 카카오 앱을 연다.
//
// 검은 화면 방지:
//  · 진입 애니메이션 뒤 컨테이너 크기가 확정되므로 relayout()으로 다시 그린다(안 하면 회색/검정).
//  · 타일 로드 성공(tilesloaded) 전엔 로딩, 실패/타임아웃이면 에러 문구를 띄운다(도메인 미등록 등).

type LatLng = { lat: number; lng: number }

// SDK는 한 번만 로드한다.
let kakaoLoad: Promise<unknown> | null = null
function loadKakao(key: string): Promise<unknown> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any
  if (w.kakao?.maps) return Promise.resolve(w.kakao)
  if (kakaoLoad) return kakaoLoad
  kakaoLoad = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${key}&autoload=false`
    s.async = true
    s.onload = () => w.kakao.maps.load(() => resolve(w.kakao))
    s.onerror = () => reject(new Error('kakao sdk load failed'))
    document.head.appendChild(s)
  })
  return kakaoLoad
}

export default function KakaoDirectionsMap({ dest, origin }: { dest: LatLng; origin: LatLng | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_KAKAO_JS_KEY
    if (!key || !ref.current) { setStatus('error'); return }
    let cancelled = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let map: any = null
    // 타일이 일정 시간 안에 안 뜨면(도메인 미등록 등) 에러로 본다.
    const failTimer = setTimeout(() => { if (!cancelled) setStatus('error') }, 7000)

    loadKakao(key)
      .then((k) => {
        if (cancelled || !ref.current) return
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const kakao = k as any
        const destLL = new kakao.maps.LatLng(dest.lat, dest.lng)
        map = new kakao.maps.Map(ref.current, { center: destLL, level: 4 })
        new kakao.maps.Marker({ position: destLL, map })

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let bounds: any = null
        if (origin) {
          const originLL = new kakao.maps.LatLng(origin.lat, origin.lng)
          new kakao.maps.CustomOverlay({
            position: originLL,
            content:
              '<div style="width:14px;height:14px;background:#0a84ff;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.2)"></div>',
            xAnchor: 0.5,
            yAnchor: 0.5,
            map,
          })
          new kakao.maps.Polyline({
            path: [originLL, destLL],
            strokeWeight: 3,
            strokeColor: '#ff7a18',
            strokeOpacity: 0.6,
            strokeStyle: 'shortdash',
            map,
          })
          bounds = new kakao.maps.LatLngBounds()
          bounds.extend(destLL)
          bounds.extend(originLL)
          map.setBounds(bounds, 48, 48, 48, 48)
        }

        kakao.maps.event.addListener(map, 'tilesloaded', () => {
          if (cancelled) return
          clearTimeout(failTimer)
          setStatus('ok')
        })

        // 진입 애니메이션(≈420ms)이 끝나 컨테이너 크기가 확정된 뒤 다시 그린다.
        setTimeout(() => {
          if (cancelled || !map) return
          map.relayout()
          if (bounds) map.setBounds(bounds, 48, 48, 48, 48)
          else map.setCenter(destLL)
        }, 450)
      })
      .catch(() => {
        if (cancelled) return
        clearTimeout(failTimer)
        setStatus('error')
      })

    return () => { cancelled = true; clearTimeout(failTimer) }
  }, [dest.lat, dest.lng, origin?.lat, origin?.lng])

  return (
    <div className="relative h-full w-full bg-[#e9e9ee] dark:bg-[#26262a]">
      <div ref={ref} className="h-full w-full" />
      {status !== 'ok' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center">
          <p className="t-caption whitespace-pre-line text-[12.5px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
            {status === 'loading'
              ? '카카오 지도 불러오는 중…'
              : '지도를 불러오지 못했어요.\n아래 ‘카카오맵으로 길찾기’로 열어주세요.'}
          </p>
        </div>
      )}
    </div>
  )
}
