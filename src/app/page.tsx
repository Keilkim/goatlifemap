'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import type { Map as LeafletMap } from 'leaflet'
import type { Store, Menu, ViewMode, Area } from '@/lib/types'
import { distanceMeters, walkMinutes } from '@/lib/coords'
import { visibleRadius, radiusLabel } from '@/lib/geo'
import { initAnalytics, track, DwellTimer } from '@/lib/analytics'
import { CATEGORY_FILTERS } from '@/lib/categories'
import Sheet from '@/components/Sheet'
import MenuList from '@/components/MenuList'
import MenuReview from '@/components/MenuReview'
import Segmented from '@/components/Segmented'
import { type Cluster } from '@/lib/cluster'

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
  // 검색 단위는 화면 중심 + 반경이다 (사각형이 아니라).
  const [area, setArea] = useState<Area | null>(null)
  // 실제로 검색이 끝난 영역. 이것만 지도에 원으로 그린다.
  // 지도를 움직이는 중에 원이 따라다니면 아직 안 찾은 범위를 찾은 척하게 된다.
  const [searched, setSearched] = useState<Area | null>(null)
  const [variant, setVariant] = useState<string | null>(null)
  const [points, setPoints] = useState(0)
  const [locating, setLocating] = useState(false)
  // 하단 시트. 두 가지만 담는다 — 그 가게의 전체 메뉴, 또는 그 메뉴의 리뷰.
  // fromMenus는 "전체 메뉴를 거쳐 리뷰로 왔나"다. 그래야 뒤로가기를 줄지 알 수 있다.
  const [sheet, setSheet] = useState<
    | { kind: 'menus'; store: Store }
    | { kind: 'review'; store: Store; menu: Menu; fromMenus: boolean }
    | null
  >(null)
  const [clusters, setClusters] = useState<Cluster[]>([])
  // onMove 콜백이 직전 줌을 알아야 클러스터 경계를 넘었는지 판단할 수 있다.
  // 렌더에 쓰이지 않으므로 상태가 아니라 ref다.
  const zoomRef = useRef(15)
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
  const fetchStores = useCallback(
    async (area: Area, price: number, categories: string[]) => {
      setLoading(true)
      const p = new URLSearchParams({
        centerLat: String(area.lat), centerLng: String(area.lng),
        radiusM: String(Math.round(area.radiusM)),
        maxPrice: String(price), zoom: String(area.zoom),
      })
      categories.forEach((c) => p.append('category', c))
      try {
        const res = await fetch(`/api/stores?${p}`)
        const d: {
          mode?: string; stores: Store[]; clusters?: Cluster[]
          storesWithoutMenus: number
        } = await res.json()
        setStores(d.stores ?? [])
        setClusters(d.clusters ?? [])
        setEmptyAreaStores(d.storesWithoutMenus ?? 0)
        // 검색이 끝난 뒤에야 원을 그린다 — 아직 안 찾은 범위를 찾은 척하면 안 된다
        setSearched(area)
      } finally {
        setLoading(false)
      }
    },
    []
  )

  // 지도에서 손을 떼면 그 자리를 바로 찾는다.
  //
  // 전에는 "이 지역에서 다시 찾기" 버튼을 띄웠다. 드래그 중에 매 프레임 조회하면
  // 화면이 흔들리고 호출도 낭비라서였는데, moveend/zoomend는 드래그가 끝난 뒤에만
  // 한 번 오므로 그 걱정이 애초에 없었다. 버튼은 사용자에게 일을 하나 더 시킨 셈이다.
  const onMove = useCallback((map: LeafletMap) => {
    const c = map.getCenter()
    const area: Area = { lat: c.lat, lng: c.lng, radiusM: visibleRadius(map), zoom: map.getZoom() }
    zoomRef.current = area.zoom
    setArea(area)
    fetchStores(area, maxPrice, cats)
  }, [fetchStores, maxPrice, cats])

  // 필터가 바뀌면 현재 영역을 즉시 다시 조회한다.
  const applyFilters = (price: number, categories: string[]) => {
    setMaxPrice(price)
    setCats(categories)
    if (area) fetchStores(area, price, categories)
  }


  const switchView = (next: ViewMode) => {
    if (next === view) return
    const ms = dwell.current?.lap() ?? 0
    // 토글 클릭 수가 아니라 "각 보기에서 얼마나 머물다 왜 옮겼는지"가 니즈의 신호다.
    track('toggle_switch', { from: view, to: next, dwell_ms: ms, variant })
    setView(next)
  }

  // 현재 위치. 사용자가 버튼을 누를 때만 1회 조회한다.
  //
  // watchPosition으로 실시간 추적하지 않는다. 위치를 지속 수집하면 위치정보법상
  // 검토가 필요해지는데, 내 위치를 지도에서 확인하거나 도보 거리를 계산하는 데는
  // 1회 조회로 충분하다. 브라우저 밖으로 위치를 보내지도 않는다 — 서버로 전송하지
  // 않고, 길찾기도 목적지만 카카오맵에 넘긴다.
  const locate = () => {
    if (!navigator.geolocation) return
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        setUserLocation(loc)
        setFlyTo([loc.lat, loc.lng])
        setLocating(false)
      },
      () => {
        setLocating(false)
        alert('위치 권한이 필요해요')
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    )
  }

  const withDistance = useCallback(
    (lat: number, lng: number) =>
      userLocation ? distanceMeters(userLocation, { lat, lng }) : null,
    [userLocation]
  )

  const isClustered = clusters.length > 0
  const clusterTotal = useMemo(() => clusters.reduce((n, c) => n + c.count, 0), [clusters])

  const closeSheet = useCallback(() => setSheet(null), [])

  // 가격 검증. 이 서비스의 생사는 "지금 그 가격이 맞나"에 달려 있으므로
  // 목록을 없애도 검증까지 없앨 수는 없다. 카드 안에서 한 번의 탭으로 한다.
  const verify = useCallback(async (menuId: string, kind: string) => {
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
      // 품절 제보는 지도에서 바로 빠져야 하므로 다시 조회한다
      if (area) fetchStores(area, maxPrice, cats)
    } else {
      alert(d.error)
    }
  }, [fetchStores, area, maxPrice, cats])

  // 길찾기는 목적지만 넘기고 카카오맵에 맡긴다.
  // 출발지 좌표를 우리가 넘길 이유가 없다 — 카카오맵이 알아서 사용자 위치를 잡고,
  // 우리는 위치정보를 취급하지 않아도 된다.
  const directions = useCallback((lat: number, lng: number, name: string) => {
    track('directions_click', { name, view })
    window.open(`https://map.kakao.com/link/to/${encodeURIComponent(name)},${lat},${lng}`, '_blank')
  }, [view])

  // 지도 위 메뉴를 바로 눌렀다 → 그 메뉴의 리뷰. 전체 메뉴를 거치지 않았으므로 뒤로가기가 없다.
  const openReviewFromMap = useCallback((store: Store, menuId: string) => {
    const menu = store.menus.find((m) => m.id === menuId)
    if (!menu) return
    setSelectedId(store.id)
    track('menu_card_click', { id: menuId, name: menu.name, price: menu.price, from: 'map' })
    setSheet({ kind: 'review', store, menu, fromMenus: false })
  }, [])

  // 식당을 눌렀거나 "메뉴 N개 더"를 눌렀다 → 그 가게 전체 메뉴
  const openMenus = useCallback((store: Store) => {
    setSelectedId(store.id)
    track('store_card_click', { id: store.id, name: store.name })
    setSheet({ kind: 'menus', store })
  }, [])

  return (
    <main className="relative h-dvh overflow-hidden bg-white dark:bg-black">
      {/* 지도가 곧 서비스다.
          목록을 따로 두지 않는다 — 지도에 이미 음식과 가격이 다 적혀 있는데
          아래에 같은 걸 또 나열하면 화면만 반으로 잘라먹는다. */}
      <MapView
        stores={stores}
        clusters={clusters}
        selectedId={selectedId}
        view={view}
        selectedMenuId={sheet?.kind === 'review' ? sheet.menu.id : null}
        onMenuTap={openReviewFromMap}
        onStoreTap={openMenus}
        onMove={onMove}
        userLocation={userLocation}
        flyTo={flyTo}
        onLocate={locate}
        locating={locating}
        searchedRadius={searched?.radiusM ?? 0}
        searchedCenter={searched ? [searched.lat, searched.lng] : null}
        onPopupClose={closeSheet}
      />

      {/* 상단 크롬 — 지도 위에 떠 있는 반투명 층. 지도를 잘라먹지 않는다. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[1100]">
        <header className="jm-chrome pointer-events-auto flex items-center justify-between px-4 pb-2 pt-3">
          <div className="flex items-baseline gap-2">
            <h1 className="t-display text-[19px] font-bold text-[#1c1c1e] dark:text-[#f2f2f7]">갓생맵</h1>
            <span className="t-caption hidden text-[11.5px] font-medium text-[#3c3c43]/55 min-[380px]:inline dark:text-[#ebebf5]/55">
              열심히 사는 이들을 위한 공간 정보
            </span>
          </div>
          {points > 0 && (
            <span className="t-price rounded-full bg-[#ff7a18]/12 px-2.5 py-1 text-[12px] font-semibold text-[#ff7a18]">
              {points}P
            </span>
          )}
        </header>

        <div className="jm-chrome jm-scroll pointer-events-auto flex gap-1.5 overflow-x-auto px-4 pb-2.5 pt-0.5">
          {PRICE_STEPS.map((p) => (
            <button
              key={p}
              onClick={() => { applyFilters(p, cats); track('filter_change', { type: 'price', value: p }) }}
              className={`jm-chip t-caption shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold ${
                maxPrice === p
                  ? 'bg-[#1c1c1e] text-white dark:bg-white dark:text-[#1c1c1e]'
                  : 'bg-black/[0.05] text-[#3c3c43]/70 dark:bg-white/[0.09] dark:text-[#ebebf5]/70'
              }`}
            >
              {(p / 1000).toLocaleString()}천원 이하
            </button>
          ))}
          <div className="mx-1 my-1 w-px shrink-0 bg-[#3c3c43]/12 dark:bg-[#545458]/50" />
          {CATEGORY_FILTERS.map(({ label }) => (
            <button
              key={label}
              onClick={() => {
                const next = cats.includes(label) ? cats.filter((x) => x !== label) : [...cats, label]
                applyFilters(maxPrice, next)
                track('filter_change', { type: 'category', value: next })
              }}
              className={`jm-chip t-caption shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold ${
                cats.includes(label)
                  ? 'bg-[#1c1c1e] text-white dark:bg-white dark:text-[#1c1c1e]'
                  : 'bg-black/[0.05] text-[#3c3c43]/70 dark:bg-white/[0.09] dark:text-[#ebebf5]/70'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 이 지역에서 다시 찾기 — 필터 바로 아래 */}

      {/* 하단 토글 — 지도 위 마커가 메뉴를 보여줄지 식당을 보여줄지 바꾼다.
          메뉴로 보기가 왼쪽이다: 이 서비스의 주장이 "식당이 아니라 메뉴"이므로
          먼저 오는 자리를 준다. 단 처음 선택되는 쪽은 A/B가 정한다 —
          기본값을 한쪽으로 고정하면 그 보기 사용량이 당연히 높게 나와 니즈를 오독한다. */}
      <div className="absolute inset-x-0 bottom-0 z-[1100] flex flex-col items-center gap-2 px-3 pb-4">
        {searched && !isClustered && (
          <span className="jm-card t-caption pointer-events-none rounded-full px-2.5 py-1 text-[10.5px] font-medium text-[#3c3c43]/70 dark:text-[#ebebf5]/70">
            {radiusLabel(searched.radiusM)} · {isClustered ? `${clusterTotal.toLocaleString()}곳` : `${stores.length}곳`}
          </span>
        )}
        {isClustered && (
          <span className="jm-card t-caption pointer-events-none rounded-full px-3 py-1.5 text-[11px] font-medium text-[#3c3c43]/70 dark:text-[#ebebf5]/70">
            확대하면 메뉴와 가격이 보여요 · 이 화면에 {clusterTotal.toLocaleString()}곳
          </span>
        )}

        <div className="jm-card rounded-[12px] p-1">
          <Segmented
            value={view}
            onChange={switchView}
            options={[
              { value: 'menu', label: '메뉴로 보기' },
              { value: 'store', label: '식당으로 보기' },
            ]}
          />
        </div>
      </div>

      {/* 이 지역에 가게는 있는데 메뉴가 아직 없을 때.
          "데이터 없음"으로 끝내면 고장난 앱처럼 보인다. */}
      {!loading && !isClustered && stores.length === 0 && (
        <div className="jm-card t-caption pointer-events-none absolute left-1/2 top-1/2 z-[1000] -translate-x-1/2 -translate-y-1/2 rounded-2xl px-4 py-3 text-center">
          <p className="text-[13px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">
            {emptyAreaStores > 0
              ? `이 근처 식당 ${emptyAreaStores.toLocaleString()}곳의 메뉴를 모으는 중이에요`
              : '이 근처엔 아직 데이터가 없어요'}
          </p>
          <p className="mt-0.5 text-[11px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
            지도를 옮기거나 가격 조건을 넓혀보세요
          </p>
        </div>
      )}

      {/* 하단 시트 — 전체 메뉴 아니면 메뉴 리뷰, 둘 뿐이다. */}
      {sheet?.kind === 'menus' && (
        <Sheet
          open
          onClose={closeSheet}
          title={sheet.store.name}
          subtitle={`${sheet.store.category ?? ''} · 메뉴 ${sheet.store.menus.length}개${
            withDistance(sheet.store.lat, sheet.store.lng) !== null
              ? ` · 도보 ${walkMinutes(withDistance(sheet.store.lat, sheet.store.lng)!)}분`
              : ''
          }`}
        >
          <MenuList
            store={sheet.store}
            onDirections={() => directions(sheet.store.lat, sheet.store.lng, sheet.store.name)}
            // 전체 메뉴에서 메뉴를 눌러 리뷰로 들어가면 뒤로 돌아갈 수 있어야 한다
            onMenuClick={(menu) => {
              track('menu_card_click', { id: menu.id, name: menu.name, price: menu.price, from: 'menu_sheet' })
              setSheet({ kind: 'review', store: sheet.store, menu, fromMenus: true })
            }}
          />
        </Sheet>
      )}

      {sheet?.kind === 'review' && (
        <Sheet
          open
          onClose={closeSheet}
          // 전체 메뉴를 거쳐 왔을 때만 뒤로가기. 지도에서 바로 왔으면 돌아갈 곳이 없다.
          onBack={sheet.fromMenus ? () => setSheet({ kind: 'menus', store: sheet.store }) : undefined}
          title={sheet.menu.name}
          subtitle={sheet.store.name}
        >
          <MenuReview key={sheet.menu.id} menu={sheet.menu} storeName={sheet.store.name} onVerify={verify} />
        </Sheet>
      )}
    </main>
  )
}
