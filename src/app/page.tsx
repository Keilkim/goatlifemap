'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import type { Map as LeafletMap } from 'leaflet'
import type { Store, Menu, ViewMode, Area } from '@/lib/types'
import { distanceMeters, walkMinutes } from '@/lib/coords'
import { visibleRadius, radiusLabel } from '@/lib/geo'
import { initAnalytics, track, DwellTimer } from '@/lib/analytics'
import { CATEGORY_FILTERS } from '@/lib/categories'
import MapLoading from '@/components/MapLoading'
import Sheet from '@/components/Sheet'
import MenuList from '@/components/MenuList'
import MenuReview from '@/components/MenuReview'
import ChatSheet from '@/components/ChatSheet'
import ReviewCompose from '@/components/ReviewCompose'
import DirectionsLightbox from '@/components/DirectionsLightbox'
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
  const [view, setView] = useState<ViewMode>('menu')
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
  const [userId, setUserId] = useState<string | null>(null)
  const [points, setPoints] = useState(0)
  const [locating, setLocating] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  // 리뷰 쓰기 전체화면. 읽기(시트)와 분리한다.
  const [composeMenu, setComposeMenu] = useState<{ menu: Menu; storeName: string } | null>(null)
  // 길찾기 라이트박스 — 카카오맵을 앱 안 팝업으로 띄운다.
  const [dirDest, setDirDest] = useState<{ lat: number; lng: number; name: string } | null>(null)
  // 작성 성공 시 이 값을 올려 뒤의 리뷰 목록을 다시 불러오게 한다.
  const [reviewRefresh, setReviewRefresh] = useState(0)
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
  // 세션 시작 + A/B 그룹 배정.
  // 기본 보기는 메뉴보기로 고정한다(제품 결정) — 이 서비스는 메뉴를 먼저 보여주는 게 맞다.
  // variant는 분석·채팅 게이팅용으로 계속 배정하되 기본 보기엔 영향을 주지 않는다.
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
      .then((d: { userId: string; variant: string; points: number }) => {
        setUserId(d.userId)
        initAnalytics(d.userId, sessionId)
        setVariant(d.variant)
        setPoints(d.points)
        const initial: ViewMode = 'menu'
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
      // 정밀 GPS(enableHighAccuracy)는 모바일에서 5~8초 걸린다. 지도 중심 잡기엔
      // 네트워크(WiFi/셀) 위치로 충분하고 훨씬 빠르다. 캐시된 위치도 2분까지 재사용.
      { enableHighAccuracy: false, timeout: 6000, maximumAge: 120000 }
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
  // 성공했는지 boolean으로 돌려준다 — 호출부(가격 변경 입력)가 성공했을 때만
  // "접수됐어요"를 띄우게. 실패(중복 제보 409·차단 403·오프라인)인데도 접수된 척하면 안 된다.
  const verify = useCallback(async (menuId: string, kind: string, reportedPrice?: number): Promise<boolean> => {
    if (!userId) return false
    track('verify_click', { menuId, kind })
    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId, menuId, kind,
          ...(reportedPrice != null ? { reportedPrice } : {}),
        }),
      })
      const d = await res.json()
      if (res.ok) {
        setPoints(d.points)
        if (area) fetchStores(area, maxPrice, cats)
        return true
      }
      alert(d.error)
      return false
    } catch {
      alert('연결이 불안정해요')
      return false
    }
  }, [fetchStores, area, maxPrice, cats, userId])

  // 길찾기 → 앱 안 라이트박스로 카카오맵을 띄운다(새 탭이 아니라).
  // 출발지=내 위치 자동 잡기와 폴백은 라이트박스가 처리한다. 여기선 목적지만 넘긴다.
  //
  // 단, 모바일(터치)에선 카카오 링크가 앱링크(applink.map.kakao.com)로 리다이렉트되고
  // 그 페이지가 X-Frame-Options: SAMEORIGIN이라 우리 iframe에 못 박힌다 → 빈 팝업이 된다.
  // 그래서 모바일은 라이트박스 대신 카카오맵을 바로 연다(앱 설치 시 앱, 아니면 모바일웹으로
  // 길안내). 데스크탑은 웹지도로 리다이렉트돼 iframe이 정상 동작하므로 라이트박스를 쓴다.
  const directions = useCallback((lat: number, lng: number, name: string) => {
    track('directions_click', { name, view })
    const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
    if (coarse) {
      const to = `${encodeURIComponent(name)},${lat},${lng}`
      const url = userLocation
        ? `https://map.kakao.com/link/from/${encodeURIComponent('내 위치')},${userLocation.lat},${userLocation.lng}/to/${to}`
        : `https://map.kakao.com/link/to/${to}`
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }
    setDirDest({ lat, lng, name })
  }, [view, userLocation])

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

      {/* 팬/필터로 데이터 받는 동안 지도 중앙 로딩 표시(카테고리 아이콘 통통) */}
      {loading && <MapLoading />}

      {/* 상단 크롬 — 지도 위에 떠 있는 반투명 층. 지도를 잘라먹지 않는다. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[1100]">
        <header className="jm-chrome pointer-events-auto flex items-center justify-between px-4 pb-2 pt-[calc(env(safe-area-inset-top)+12px)]">
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
      <div className="absolute inset-x-0 bottom-0 z-[1100] flex flex-col items-center gap-2 px-3 pb-[calc(env(safe-area-inset-bottom)+16px)]">
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

      {/* 수다방 버튼 — 우하단 코너에 확실히 앉힌다. 홈 인디케이터·제스처 바에 안 물리도록
          env(safe-area-inset-bottom)만큼 띄운다(기기마다 이 높이가 다르다).
          세션이 잡힌(variant 배정된) 뒤에만 띄운다 — 익명 신원이 있어야 글을 쓴다. */}
      {variant && !chatOpen && (
        <button
          onClick={() => { setChatOpen(true); track('chat_open', {}) }}
          aria-label="수다방"
          className="jm-card jm-press absolute bottom-[calc(env(safe-area-inset-bottom)+16px)] right-4 z-[1100] flex size-12 items-center justify-center rounded-full"
        >
          <svg viewBox="0 0 24 24" className="size-5 text-[#ff7a18]" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.5 8.5 0 0 1-12.5 7.5L3 21l1.5-4.5A8.5 8.5 0 1 1 21 11.5z" />
          </svg>
        </button>
      )}

      <ChatSheet open={chatOpen} onClose={() => setChatOpen(false)} userId={userId} />

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
          <MenuReview
            key={sheet.menu.id}
            menu={sheet.menu}
            storeName={sheet.store.name}
            onVerify={verify}
            onDirections={() => directions(sheet.store.lat, sheet.store.lng, sheet.store.name)}
            onShowMenus={() => setSheet({ kind: 'menus', store: sheet.store })}
            onCompose={() => setComposeMenu({ menu: sheet.menu, storeName: sheet.store.name })}
            refreshKey={reviewRefresh}
          />
        </Sheet>
      )}

      {/* 리뷰 쓰기 — 전체화면. 시트(읽기) 위를 덮는다. */}
      {composeMenu && (
        <ReviewCompose
          menu={composeMenu.menu}
          storeName={composeMenu.storeName}
          onClose={() => setComposeMenu(null)}
          onSubmitted={(pts) => { setReviewRefresh((n) => n + 1); setPoints(pts) }}
        />
      )}

      {/* 길찾기 라이트박스 — 카카오맵을 앱 안 팝업으로. 최상단을 덮는다. */}
      {dirDest && (
        <DirectionsLightbox
          dest={dirDest}
          userLocation={userLocation}
          onClose={() => setDirDest(null)}
          onLocated={setUserLocation}
        />
      )}
    </main>
  )
}
