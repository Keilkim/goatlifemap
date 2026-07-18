'use client'

import { useEffect, useRef } from 'react'

// 카카오 지도 팝업(모바일용).
//
// 카카오는 자기 지도가 남의 iframe에 박히는 걸 X-Frame-Options로 막지만, Kakao Maps
// JavaScript SDK는 우리 페이지 DOM에 지도를 '직접' 그리는 방식이라 그 제한을 받지 않는다.
// 그래서 모바일에서도 앱 안 팝업에 진짜 카카오 지도를 띄울 수 있다.
//
// 지도·타일·위치기반서비스는 카카오가 제공한다(우리가 만들지 않는다). 실제 턴바이턴 경로는
// SDK 기본 기능이 아니라(별도 유료 API) 목적지·내 위치 마커와 직선만 그리고, 실제 길안내는
// 팝업 아래 '카카오맵으로 길찾기' 버튼이 카카오 앱을 열어 처리한다.

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
    // autoload=false: 스크립트 로드 후 kakao.maps.load로 초기화 시점을 우리가 정한다.
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

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_KAKAO_JS_KEY
    if (!key || !ref.current) return
    let cancelled = false

    loadKakao(key)
      .then((k) => {
        if (cancelled || !ref.current) return
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const kakao = k as any
        const destLL = new kakao.maps.LatLng(dest.lat, dest.lng)
        const map = new kakao.maps.Map(ref.current, { center: destLL, level: 4 })

        // 목적지 마커(카카오 기본 핀)
        new kakao.maps.Marker({ position: destLL, map })

        if (origin) {
          const originLL = new kakao.maps.LatLng(origin.lat, origin.lng)
          // 내 위치 — 파란 점
          new kakao.maps.CustomOverlay({
            position: originLL,
            content:
              '<div style="width:14px;height:14px;background:#0a84ff;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.2)"></div>',
            xAnchor: 0.5,
            yAnchor: 0.5,
            map,
          })
          // 직선 힌트(실제 경로 아님)
          new kakao.maps.Polyline({
            path: [originLL, destLL],
            strokeWeight: 3,
            strokeColor: '#ff7a18',
            strokeOpacity: 0.6,
            strokeStyle: 'shortdash',
            map,
          })
          // 둘 다 보이게
          const bounds = new kakao.maps.LatLngBounds()
          bounds.extend(destLL)
          bounds.extend(originLL)
          map.setBounds(bounds, 48, 48, 48, 48)
        }
      })
      .catch(() => { /* 로드 실패해도 아래 '카카오맵으로 길찾기' 버튼은 동작한다 */ })

    return () => { cancelled = true }
  }, [dest.lat, dest.lng, origin?.lat, origin?.lng])

  return <div ref={ref} className="h-full w-full" />
}
