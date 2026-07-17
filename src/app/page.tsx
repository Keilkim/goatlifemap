'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import type { Map as LeafletMap } from 'leaflet'
import type { Store, MenuRow, ViewMode, Area } from '@/lib/types'
import { distanceMeters, walkMinutes } from '@/lib/coords'
import { visibleRadius, radiusLabel } from '@/lib/geo'
import { initAnalytics, track, DwellTimer } from '@/lib/analytics'
import { CATEGORY_FILTERS } from '@/lib/categories'
import StoreCard from '@/components/StoreCard'
import Segmented from '@/components/Segmented'
import { CLUSTER_ZOOM, type Cluster } from '@/lib/cluster'

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
  // 지도를 움직였지만 아직 다시 찾지 않은 영역
  const [stale, setStale] = useState<Area | null>(null)
  // 실제로 검색이 끝난 영역. 이것만 지도에 원으로 그린다.
  // 지도를 움직이는 중에 원이 따라다니면 아직 안 찾은 범위를 찾은 척하게 된다.
  const [searched, setSearched] = useState<Area | null>(null)
  const [variant, setVariant] = useState<string | null>(null)
  const [points, setPoints] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [hasDemo, setHasDemo] = useState(false)
  const [locating, setLocating] = useState(false)
  // 마커를 눌러 카드를 띄운 가게. 목록 클릭만으로는 카드를 띄우지 않는다.
  const [cardStoreId, setCardStoreId] = useState<string | null>(null)
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
          truncated: boolean; storesWithoutMenus: number
        } = await res.json()
        setStores(d.stores ?? [])
        setClusters(d.clusters ?? [])
        setTruncated(d.truncated)
        setEmptyAreaStores(d.storesWithoutMenus ?? 0)
        setHasDemo((d.stores ?? []).some((s) => s.source === 'demo'))
        // 검색이 끝난 뒤에야 원을 그린다 — 아직 안 찾은 범위를 찾은 척하면 안 된다
        setSearched(area)
        setStale(null)
      } finally {
        setLoading(false)
      }
    },
    []
  )

  // 지도를 움직일 때마다 자동 재조회하면 화면이 계속 흔들리고 호출도 낭비된다.
  // 대신 "이 지역에서 다시 찾기" 버튼을 띄워 사용자가 원할 때만 조회한다.
  // 단 최초 1회는 사용자가 아무것도 안 했는데 화면이 비어 있으면 안 되므로 바로 조회한다.
  const loadedOnce = useRef(false)
  const onMove = useCallback((map: LeafletMap) => {
    const c = map.getCenter()
    const area: Area = { lat: c.lat, lng: c.lng, radiusM: visibleRadius(map), zoom: map.getZoom() }

    if (!loadedOnce.current) {
      loadedOnce.current = true
      setArea(area)
      fetchStores(area, maxPrice, cats)
      return
    }

    // 줌이 클러스터 경계를 넘나들면 화면이 통째로 바뀌어야 하므로 즉시 조회한다.
    // "다시 찾기"를 기다리게 하면 개수 원과 가격 칩이 뒤섞여 보인다.
    const wasCluster = zoomRef.current < CLUSTER_ZOOM
    const isCluster = area.zoom < CLUSTER_ZOOM
    zoomRef.current = area.zoom
    if (wasCluster !== isCluster || isCluster) {
      setArea(area)
      fetchStores(area, maxPrice, cats)
      return
    }
    setStale(area)
  }, [fetchStores, maxPrice, cats])

  // 필터가 바뀌면 현재 영역을 즉시 다시 조회한다.
  const applyFilters = (price: number, categories: string[]) => {
    setMaxPrice(price)
    setCats(categories)
    if (area) fetchStores(area, price, categories)
  }

  const research = () => {
    if (!stale) return
    setArea(stale)
    fetchStores(stale, maxPrice, cats)
    track('map_research')
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

  // 재조회로 목록이 바뀌면 사라진 가게의 카드는 자동으로 닫힌다
  const cardStore = useMemo(
    () => stores.find((s) => s.id === cardStoreId) ?? null,
    [stores, cardStoreId]
  )

  const isClustered = clusters.length > 0
  const clusterTotal = useMemo(() => clusters.reduce((n, c) => n + c.count, 0), [clusters])

  const closeCard = useCallback(() => setCardStoreId(null), [])

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
      if (area) fetchStores(area, maxPrice, cats)
    } else {
      alert(d.error)
    }
  }

  // 길찾기는 목적지만 넘기고 카카오맵에 맡긴다.
  // 출발지 좌표를 우리가 넘길 이유가 없다 — 카카오맵이 알아서 사용자 위치를 잡고,
  // 우리는 위치정보를 취급하지 않아도 된다.
  const directions = useCallback((lat: number, lng: number, name: string) => {
    track('directions_click', { name, view })
    window.open(`https://map.kakao.com/link/to/${encodeURIComponent(name)},${lat},${lng}`, '_blank')
  }, [view])

  // 카드는 그 가게 포인트에 붙어서 뜬다. 화면 하단에 폭 넓게 띄우면
  // 어느 가게 것인지 눈으로 잇지 못하고 지도도 통째로 가린다.
  // useCallback으로 고정하지 않으면 매 렌더마다 지도 전체가 다시 그려진다.
  const renderCard = useCallback(
    (s: Store) => (
      <StoreCard
        store={s}
        distance={withDistance(s.lat, s.lng)}
        onDirections={() => directions(s.lat, s.lng, s.name)}
        onMenuClick={(menuId) => {
          const m = s.menus.find((x) => x.id === menuId)
          track('menu_card_click', { id: menuId, name: m?.name, price: m?.price, from: 'map_card' })
        }}
      />
    ),
    [withDistance, directions]
  )

  return (
    <main className="flex h-dvh flex-col bg-white dark:bg-neutral-950">
      {/* 상단 크롬은 반투명 층이다. 불투명한 띠로 화면을 잘라먹지 않는다. */}
      <header className="jm-chrome sticky top-0 z-20 flex items-center justify-between px-4 pb-2 pt-3">
        <div className="flex items-baseline gap-2">
          <h1 className="t-display text-[19px] font-bold text-[#1c1c1e] dark:text-[#f2f2f7]">점심방어</h1>
          <span className="t-caption text-[11.5px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
            만원 이하 점심 지도
          </span>
        </div>
        {/* 현재 위치 버튼은 지도 우측 상단에 있다 */}
        {points > 0 && (
          <span className="t-price rounded-full bg-[#ff7a18]/12 px-2.5 py-1 text-[12px] font-semibold text-[#ff7a18]">
            {points}P
          </span>
        )}
      </header>

      {hasDemo && (
        <div className="t-caption bg-[#ff9f0a]/10 px-4 py-1.5 text-center text-[11px] font-medium text-[#b25000] dark:text-[#ffb340]">
          데모 데이터입니다 — 실제 가게·가격이 아닙니다
        </div>
      )}

      <div className="jm-chrome jm-scroll flex gap-1.5 overflow-x-auto px-4 pb-2.5 pt-0.5">
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

      <div className="relative h-[45vh] shrink-0">
        <MapView
          stores={stores}
          clusters={clusters}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id)
            setCardStoreId(id)
            const s = stores.find((x) => x.id === id)
            track('marker_click', { id, name: s?.name, view })
          }}
          onMove={onMove}
          userLocation={userLocation}
          flyTo={flyTo}
          onLocate={locate}
          locating={locating}
          searchedRadius={searched?.radiusM ?? 0}
          searchedCenter={searched ? [searched.lat, searched.lng] : null}
          onPopupClose={closeCard}
          renderCard={renderCard}
        />
        {stale && !cardStore && (
          <button
            onClick={research}
            className="jm-press jm-card t-caption absolute left-1/2 top-3 z-[1000] -translate-x-1/2 rounded-full px-4 py-2 text-[12px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]"
          >
            이 지역에서 다시 찾기
          </button>
        )}

        {/* 원이 몇 미터인지 말해주지 않으면 장식일 뿐이다 */}
        {searched && !cardStore && !isClustered && (
          <span className="jm-card t-caption pointer-events-none absolute bottom-2.5 left-2.5 z-[900] rounded-full px-2.5 py-1 text-[10.5px] font-medium text-[#3c3c43]/70 dark:text-[#ebebf5]/70">
            {radiusLabel(searched.radiusM)}
          </span>
        )}

      </div>

      <div className="jm-chrome flex items-center justify-between px-4 py-2">
        {/* 메뉴로 보기가 왼쪽이다 — 이 서비스의 주장이 "식당이 아니라 메뉴"이므로
            먼저 오는 자리를 준다. 단 처음 선택되는 쪽은 A/B가 정한다: 기본값을
            한쪽으로 고정하면 그 보기 사용량이 당연히 높게 나와 니즈를 오독한다. */}
        <Segmented
          value={view}
          onChange={switchView}
          options={[
            { value: 'menu', label: '메뉴로 보기' },
            { value: 'store', label: '식당으로 보기' },
          ]}
        />
        <span className="t-caption text-[11.5px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
          {loading
            ? '찾는 중…'
            : isClustered
              ? `${clusterTotal.toLocaleString()}곳`
              : view === 'store'
                ? `식당 ${storeRows.length}곳`
                : `메뉴 ${menuRows.length}개`}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {/* 클러스터 상태에서는 목록을 채우지 않는다. 화면에 수백 곳이 걸려 있는데
            그걸 다 나열해봐야 고를 수가 없다. 먼저 지역을 좁히라고 말해준다. */}
        {isClustered && !loading && (
          <div className="p-10 text-center">
            <p className="t-body text-[14px] font-medium text-[#1c1c1e] dark:text-[#f2f2f7]">
              지도를 확대하면 메뉴와 가격이 보여요
            </p>
            <p className="t-caption mt-1 text-[12px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
              동그라미를 누르면 그 동네로 들어가요
              {clusterTotal > 0 && ` · 이 화면에 ${clusterTotal.toLocaleString()}곳`}
            </p>
          </div>
        )}

        {!isClustered && !loading && stores.length === 0 && (
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
                  setCardStoreId(s.id)
                  setFlyTo([s.lat, s.lng])
                  track('store_card_click', { id: s.id, name: s.name })
                }}
                className={`w-full cursor-pointer px-4 py-3 text-left transition-colors ${
                  selectedId === s.id ? 'bg-[#ff7a18]/[0.07]' : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.03]'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="t-title truncate text-[15px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">
                    {s.name}
                  </span>
                  <span className="t-caption shrink-0 text-[11.5px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
                    {s.category}
                    {s.distance !== null && ` · 도보 ${walkMinutes(s.distance)}분`}
                  </span>
                </div>
                <p className="t-caption mt-0.5 text-[11.5px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
                  {maxPrice.toLocaleString()}원 이하 {s.menus.length}개 · 최저{' '}
                  <span className="t-price font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">
                    {s.cheapest.toLocaleString()}원
                  </span>
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {s.menus.slice(0, 3).map((m) => (
                    <span
                      key={m.id}
                      className="t-caption rounded-full bg-black/[0.04] px-2 py-1 text-[11px] font-medium text-[#3c3c43]/70 dark:bg-white/[0.07] dark:text-[#ebebf5]/70"
                    >
                      {m.name} <span className="t-price">{m.price.toLocaleString()}</span>
                    </span>
                  ))}
                  <button
                    onClick={(e) => { e.stopPropagation(); directions(s.lat, s.lng, s.name) }}
                    className="jm-press t-caption ml-auto rounded-full bg-black/[0.05] px-2.5 py-1 text-[11px] font-medium text-[#3c3c43]/65 dark:bg-white/[0.09] dark:text-[#ebebf5]/65"
                  >
                    길찾기
                  </button>
                </div>
              </div>
            ))
          : menuRows.map((m) => (
              <div
                key={m.id}
                className={`px-4 py-2.5 transition-colors ${
                  selectedId === m.storeId ? 'bg-[#ff7a18]/[0.07]' : ''
                }`}
              >
                <button
                  onClick={() => {
                    setSelectedId(m.storeId)
                    setCardStoreId(m.storeId)
                    setFlyTo([m.lat, m.lng])
                    track('menu_card_click', { id: m.id, name: m.name, price: m.price })
                  }}
                  className="flex w-full items-center gap-3 text-left"
                >
                  {m.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.image_url} alt="" loading="lazy" className="size-11 shrink-0 rounded-full object-cover" />
                  ) : (
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.07]" aria-hidden>
                      <svg viewBox="0 0 24 24" className="size-3.5 text-black/20 dark:text-white/25" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                        <path d="M7 7l10 10M17 7L7 17" />
                      </svg>
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="t-body block truncate text-[14.5px] font-medium text-[#1c1c1e] dark:text-[#f2f2f7]">
                      {m.name}
                    </span>
                    <span className="t-caption block truncate text-[11.5px] font-medium text-[#3c3c43]/55 dark:text-[#ebebf5]/55">
                      {m.storeName}
                      {m.distance !== null && ` · 도보 ${walkMinutes(m.distance)}분`}
                      {` · 확인 ${daysAgo(m.verified_at)}`}
                    </span>
                  </span>
                  <span className="t-price shrink-0 text-[16px] font-semibold text-[#1c1c1e] dark:text-[#f2f2f7]">
                    {m.price.toLocaleString()}
                    <span className="ml-0.5 text-[11px] font-medium text-[#3c3c43]/50 dark:text-[#ebebf5]/50">원</span>
                  </span>
                </button>

                {/* 검증. 이 서비스의 생사는 가격이 맞는지에 달렸으므로 한 번의 탭으로
                    확인해줄 수 있어야 한다. 다만 목록을 시끄럽게 만들면 안 되므로 작게 둔다. */}
                <div className="mt-1.5 flex gap-1.5 pl-14">
                  <button onClick={() => verify(m.id, 'price_ok')} className="jm-press t-caption rounded-full bg-black/[0.05] px-2.5 py-1 text-[11px] font-medium text-[#3c3c43]/65 dark:bg-white/[0.09] dark:text-[#ebebf5]/65">
                    가격 맞아요 · +5P
                  </button>
                  <button onClick={() => verify(m.id, 'sold_out')} className="jm-press t-caption rounded-full bg-black/[0.05] px-2.5 py-1 text-[11px] font-medium text-[#3c3c43]/65 dark:bg-white/[0.09] dark:text-[#ebebf5]/65">
                    안 팔아요 · +20P
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
