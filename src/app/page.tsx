'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import type { LatLngBounds } from 'leaflet'
import type { Store, MenuRow, ViewMode } from '@/lib/types'
import { distanceMeters, walkMinutes } from '@/lib/coords'
import { initAnalytics, track, DwellTimer } from '@/lib/analytics'
import { CATEGORY_FILTERS } from '@/lib/categories'

// Leaflet은 window를 직접 만지므로 서버에서 렌더하면 터진다.
const MapView = dynamic(() => import('@/components/MapView'), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-neutral-100 dark:bg-neutral-800" />,
})

const PRICE_STEPS = [5000, 7000, 10000] as const

export default function Home() {
  const [stores, setStores] = useState<Store[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<ViewMode>('store')
  const [maxPrice, setMaxPrice] = useState<number>(10000)
  const [cats, setCats] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null)
  const [flyTo, setFlyTo] = useState<[number, number] | null>(null)
  const [bounds, setBounds] = useState<LatLngBounds | null>(null)
  const [staleBounds, setStaleBounds] = useState<LatLngBounds | null>(null)
  const [variant, setVariant] = useState<string | null>(null)
  const [points, setPoints] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [hasDemo, setHasDemo] = useState(false)
  // 결과가 0일 때, 이 지역에 가게 자체는 몇 곳 있는지 (메뉴만 아직 없음)
  const [emptyAreaStores, setEmptyAreaStores] = useState(0)

  const dwell = useRef<DwellTimer | null>(null)
  const userIdRef = useRef<string | null>(null)

  // 세션 시작 + A/B 그룹 배정.
  // 기본 보기를 한쪽으로 고정하면 그 보기 사용량이 당연히 높게 나와 니즈를 오독한다.
  // 절반은 식당보기로, 절반은 메뉴보기로 시작시킨 뒤 반대편으로의 전환율을 비교한다.
  useEffect(() => {
    let deviceId = localStorage.getItem('jm_device_id')
    if (!deviceId) {
      deviceId = crypto.randomUUID()
      localStorage.setItem('jm_device_id', deviceId)
    }
    const sessionId = crypto.randomUUID()

    fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    })
      .then((r) => r.json())
      .then((d: { userId: string; variant: string }) => {
        userIdRef.current = d.userId
        initAnalytics(d.userId, sessionId)
        setVariant(d.variant)
        const initial: ViewMode = d.variant === 'menu_first' ? 'menu' : 'store'
        setView(initial)
        dwell.current = new DwellTimer()
        track('view_init', { variant: d.variant, view: initial })
      })
      .catch(() => { /* 로그가 안 되어도 지도는 보여야 한다 */ })

    return () => dwell.current?.dispose()
  }, [])

  // 필터 값을 상태에서 읽지 않고 인자로 받는다.
  // 그래야 필터를 누른 즉시(상태 반영을 기다리지 않고) 새 조건으로 조회할 수 있고,
  // 조회를 effect에 의존시키지 않아도 된다.
  const fetchStores = useCallback(async (b: LatLngBounds, price: number, categories: string[]) => {
    setLoading(true)
    const p = new URLSearchParams({
      minLat: String(b.getSouth()), maxLat: String(b.getNorth()),
      minLng: String(b.getWest()), maxLng: String(b.getEast()),
      maxPrice: String(price),
    })
    categories.forEach((c) => p.append('category', c))
    try {
      const res = await fetch(`/api/stores?${p}`)
      const d: { stores: Store[]; truncated: boolean; storesWithoutMenus: number } = await res.json()
      setStores(d.stores ?? [])
      setTruncated(d.truncated)
      setEmptyAreaStores(d.storesWithoutMenus ?? 0)
      setHasDemo((d.stores ?? []).some((s) => s.source === 'demo'))
      setStaleBounds(null)
    } finally {
      setLoading(false)
    }
  }, [])

  // 지도를 움직일 때마다 자동 재조회하면 화면이 계속 흔들리고 호출도 낭비된다.
  // 대신 "이 지역에서 다시 찾기" 버튼을 띄워 사용자가 원할 때만 조회한다.
  // 단 최초 1회는 사용자가 아무것도 안 했는데 화면이 비어 있으면 안 되므로 바로 조회한다.
  const loadedOnce = useRef(false)
  const onMove = useCallback((b: LatLngBounds) => {
    if (!loadedOnce.current) {
      loadedOnce.current = true
      setBounds(b)
      fetchStores(b, maxPrice, cats)
      return
    }
    setStaleBounds(b)
  }, [fetchStores, maxPrice, cats])

  // 필터가 바뀌면 현재 영역을 즉시 다시 조회한다.
  const applyFilters = (price: number, categories: string[]) => {
    setMaxPrice(price)
    setCats(categories)
    if (bounds) fetchStores(bounds, price, categories)
  }

  const research = () => {
    if (!staleBounds) return
    const b = staleBounds
    setBounds(b)
    fetchStores(b, maxPrice, cats)
    track('map_research')
  }

  const switchView = (next: ViewMode) => {
    if (next === view) return
    const ms = dwell.current?.lap() ?? 0
    // 토글 클릭 수가 아니라 "각 보기에서 얼마나 머물다 왜 옮겼는지"가 니즈의 신호다.
    track('toggle_switch', { from: view, to: next, dwell_ms: ms, variant })
    setView(next)
  }

  const locate = () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        setUserLocation(loc)
        setFlyTo([loc.lat, loc.lng])
      },
      () => alert('위치 권한이 필요해요'),
      { enableHighAccuracy: true, timeout: 8000 }
    )
  }

  const withDistance = useCallback(
    (lat: number, lng: number) =>
      userLocation ? distanceMeters(userLocation, { lat, lng }) : null,
    [userLocation]
  )

  // 같은 데이터에서 두 보기를 만든다. 메뉴보기는 가게를 메뉴 단위로 펼친 것.
  const menuRows: MenuRow[] = useMemo(() => {
    const rows = stores.flatMap((s) =>
      s.menus.map((m) => ({
        ...m,
        storeId: s.id, storeName: s.name, category: s.category,
        lat: s.lat, lng: s.lng,
        distance: withDistance(s.lat, s.lng),
      }))
    )
    return rows.sort((a, b) =>
      userLocation && a.distance !== null && b.distance !== null
        ? a.distance - b.distance
        : a.price - b.price
    )
  }, [stores, withDistance, userLocation])

  const storeRows = useMemo(() => {
    const rows = stores.map((s) => ({ ...s, distance: withDistance(s.lat, s.lng) }))
    return rows.sort((a, b) =>
      userLocation && a.distance !== null && b.distance !== null
        ? a.distance - b.distance
        : a.cheapest - b.cheapest
    )
  }, [stores, withDistance, userLocation])

  const verify = async (menuId: string, kind: string) => {
    if (!userIdRef.current) return
    track('verify_click', { menuId, kind })
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userIdRef.current, menuId, kind }),
    })
    const d = await res.json()
    if (res.ok) {
      setPoints(d.points)
      // 품절 제보 같은 건 목록에서 바로 빠져야 하므로 다시 조회한다
      if (bounds) fetchStores(bounds, maxPrice, cats)
    } else {
      alert(d.error)
    }
  }

  const directions = (lat: number, lng: number, name: string) => {
    track('directions_click', { name, view })
    window.open(`https://map.kakao.com/link/to/${encodeURIComponent(name)},${lat},${lng}`, '_blank')
  }

  return (
    <main className="flex h-dvh flex-col bg-white dark:bg-neutral-950">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-bold tracking-tight text-neutral-900 dark:text-neutral-50">점심방어</h1>
          <span className="text-xs text-neutral-500">만원 이하 점심 지도</span>
        </div>
        <div className="flex items-center gap-2">
          {points > 0 && (
            <span className="rounded-full bg-orange-100 px-2.5 py-1 text-xs font-semibold text-orange-700 dark:bg-orange-950 dark:text-orange-300">
              {points}P
            </span>
          )}
          <button onClick={locate} className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">
            내 위치
          </button>
        </div>
      </header>

      {hasDemo && (
        <div className="bg-amber-50 px-4 py-1.5 text-center text-[11px] text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
          데모 데이터입니다 — 실제 가게·가격이 아닙니다
        </div>
      )}

      <div className="flex gap-1.5 overflow-x-auto border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        {PRICE_STEPS.map((p) => (
          <button
            key={p}
            onClick={() => { applyFilters(p, cats); track('filter_change', { type: 'price', value: p }) }}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition ${
              maxPrice === p
                ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400'
            }`}
          >
            {(p / 1000).toLocaleString()}천원 이하
          </button>
        ))}
        <div className="mx-1 w-px shrink-0 bg-neutral-200 dark:bg-neutral-700" />
        {CATEGORY_FILTERS.map(({ label }) => (
          <button
            key={label}
            onClick={() => {
              const next = cats.includes(label) ? cats.filter((x) => x !== label) : [...cats, label]
              applyFilters(maxPrice, next)
              track('filter_change', { type: 'category', value: next })
            }}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition ${
              cats.includes(label)
                ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
                : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="relative h-[45vh] shrink-0">
        <MapView
          stores={stores}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id)
            const s = stores.find((x) => x.id === id)
            track('marker_click', { id, name: s?.name, view })
          }}
          onMove={onMove}
          userLocation={userLocation}
          flyTo={flyTo}
        />
        {staleBounds && (
          <button
            onClick={research}
            className="absolute left-1/2 top-3 z-[1000] -translate-x-1/2 rounded-full bg-neutral-900 px-4 py-2 text-xs font-semibold text-white shadow-lg dark:bg-white dark:text-neutral-900"
          >
            이 지역에서 다시 찾기
          </button>
        )}
      </div>

      <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <div className="flex rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-800">
          {(['store', 'menu'] as const).map((m) => (
            <button
              key={m}
              onClick={() => switchView(m)}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition ${
                view === m
                  ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white'
                  : 'text-neutral-500'
              }`}
            >
              {m === 'store' ? '식당으로 보기' : '메뉴로 보기'}
            </button>
          ))}
        </div>
        <span className="text-xs text-neutral-500">
          {loading ? '찾는 중…' : view === 'store' ? `식당 ${storeRows.length}곳` : `메뉴 ${menuRows.length}개`}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {!loading && stores.length === 0 && (
          <div className="p-10 text-center">
            {emptyAreaStores > 0 ? (
              <>
                {/* 가게가 없는 게 아니라 메뉴가 아직 없는 것이다. 이걸 구분해 말해야
                    사용자가 "고장난 앱"이 아니라 "채워지는 중인 지도"로 읽는다. */}
                <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                  이 지역 식당 {emptyAreaStores.toLocaleString()}곳의 메뉴를 아직 모으는 중이에요
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  지금은 홍대·신촌부터 채우고 있어요
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">이 지역엔 아직 데이터가 없어요</p>
                <p className="mt-1 text-xs text-neutral-500">홍대·신촌 쪽으로 지도를 옮겨보세요</p>
              </>
            )}
          </div>
        )}

        {truncated && (
          <p className="bg-neutral-50 px-4 py-1.5 text-center text-[11px] text-neutral-500 dark:bg-neutral-900">
            결과가 많아 일부만 보여요. 지도를 확대해보세요
          </p>
        )}

        {view === 'store'
          ? storeRows.map((s) => (
              <div
                key={s.id}
                onClick={() => {
                  setSelectedId(s.id)
                  setFlyTo([s.lat, s.lng])
                  track('store_card_click', { id: s.id, name: s.name })
                }}
                className={`w-full cursor-pointer border-b border-neutral-100 px-4 py-3 text-left transition dark:border-neutral-800 ${
                  selectedId === s.id ? 'bg-orange-50 dark:bg-orange-950/30' : 'hover:bg-neutral-50 dark:hover:bg-neutral-900'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-semibold text-neutral-900 dark:text-neutral-50">{s.name}</span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {s.category}
                    {s.distance !== null && ` · 도보 ${walkMinutes(s.distance)}분`}
                  </span>
                </div>
                <p className="mt-1 text-xs text-neutral-500">
                  {maxPrice.toLocaleString()}원 이하 메뉴 {s.menus.length}개 · 최저 {s.cheapest.toLocaleString()}원
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {s.menus.slice(0, 3).map((m) => (
                    <span key={m.id} className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                      {m.name} {m.price.toLocaleString()}
                    </span>
                  ))}
                </div>
                <div className="mt-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); directions(s.lat, s.lng, s.name) }}
                    className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400"
                  >
                    길찾기
                  </button>
                </div>
              </div>
            ))
          : menuRows.map((m) => (
              <div
                key={m.id}
                className={`border-b border-neutral-100 px-4 py-3 dark:border-neutral-800 ${
                  selectedId === m.storeId ? 'bg-orange-50 dark:bg-orange-950/30' : ''
                }`}
              >
                <button
                  onClick={() => {
                    setSelectedId(m.storeId)
                    setFlyTo([m.lat, m.lng])
                    track('menu_card_click', { id: m.id, name: m.name, price: m.price })
                  }}
                  className="block w-full text-left"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-semibold text-neutral-900 dark:text-neutral-50">{m.name}</span>
                    <span className="shrink-0 font-bold text-orange-600 dark:text-orange-400">
                      {m.price.toLocaleString()}원
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-neutral-500">
                    {m.storeName}
                    {m.distance !== null && ` · 도보 ${walkMinutes(m.distance)}분`}
                  </p>
                  <p className="mt-0.5 text-[11px] text-neutral-400">가격 확인 {daysAgo(m.verified_at)}</p>
                </button>
                {/* 검증 버튼. 이 서비스의 생사는 가격이 맞는지에 달렸으므로
                    사용자가 한 번의 탭으로 확인해줄 수 있어야 한다. */}
                <div className="mt-2 flex gap-1.5">
                  <button onClick={() => verify(m.id, 'price_ok')} className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400">
                    가격 맞아요 +5P
                  </button>
                  <button onClick={() => verify(m.id, 'sold_out')} className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400">
                    지금 안 팔아요 +20P
                  </button>
                  <button onClick={() => directions(m.lat, m.lng, m.storeName)} className="ml-auto rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400">
                    길찾기
                  </button>
                </div>
              </div>
            ))}
      </div>
    </main>
  )
}

function daysAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (days <= 0) return '오늘'
  if (days === 1) return '어제'
  return `${days}일 전`
}
