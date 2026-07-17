'use client'

import { useEffect, useReducer, useRef } from 'react'
import { MapContainer, TileLayer, Marker, useMap, useMapEvents, CircleMarker, Circle } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { getTileConfig } from '@/lib/tiles'
import type { Store, ViewMode } from '@/lib/types'
import type { Cluster } from '@/lib/cluster'

// 마커는 "식당 단위"로 유지한다.
// 메뉴 단위로 마커를 찍으면 같은 건물에 마커가 겹쳐서 지도가 오히려 못 쓰게 된다.
// 대신 마커 위에 최저가와 조건에 맞는 메뉴 개수를 얹어 메뉴 정보를 노출한다.
// 클러스터 원. 개수가 많을수록 크게 — 크기 자체가 밀도를 말해준다.
function clusterIcon(count: number) {
  const size = count < 10 ? 34 : count < 50 ? 42 : count < 200 ? 50 : 58
  return L.divIcon({
    className: '',
    html: `<div class="jm-cluster" style="width:${size}px;height:${size}px">${count}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 마커 라벨.
 *
 * 기존 지도는 식당명만 띄운다. 여기서는 음식과 가격을 띄운다 — "지금 이 동네에서
 * 뭘 얼마에 먹을 수 있나"가 마커만 보고 답이 나와야 하기 때문이다.
 * 가격만 띄우면 "5,000원짜리 뭔가"가 되어 결국 눌러봐야 안다.
 *
 * 가격은 반올림하지 않는다. 3,500원을 "4천"으로 올려 표시하면 실제보다 비싸 보이는데,
 * 싼 메뉴를 찾으러 온 사용자에게 그건 그냥 거짓말이다.
 */
function priceIcon(store: Store, selected: boolean, view: ViewMode) {
  const extra = store.menus.length - 1
  const label =
    view === 'menu'
      ? // 대표 메뉴 = 가장 싼 것. 이 서비스는 싼 걸 찾으러 오는 곳이다.
        `<span class="jm-marker__name">${esc(store.menus[0]?.name ?? store.name)}</span>
         <span class="jm-marker__price">${(store.menus[0]?.price ?? store.cheapest).toLocaleString()}</span>`
      : `<span class="jm-marker__name">${esc(store.name)}</span>
         <span class="jm-marker__price">${store.cheapest.toLocaleString()}~</span>`

  return L.divIcon({
    className: '',
    html: `
      <div class="jm-anchor">
        <div class="jm-marker ${selected ? 'jm-marker--on' : ''}">
          ${label}
          ${extra > 0 ? `<span class="jm-marker__count">+${extra}</span>` : ''}
        </div>
      </div>`,
    // 라벨 길이가 제각각이라 크기를 고정하면 글자가 잘린다.
    // 크기는 CSS가 재고, 아래 중앙 정렬은 .jm-anchor가 한다.
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
}

function MapEvents({ onMove, onMapClick }: { onMove: (map: L.Map) => void; onMapClick: () => void }) {
  const map = useMapEvents({
    moveend: (e) => onMove(e.target),
    zoomend: (e) => onMove(e.target),
    // 지도 빈 곳을 누르면 카드를 닫는다. 좁은 카드에 X 버튼을 넣어
    // 길찾기와 자리를 다투게 하는 것보다 낫다.
    click: () => onMapClick(),
  })

  // moveend/zoomend는 사용자가 지도를 움직여야만 발생한다.
  // 최초 로드 때는 아무 이벤트도 안 오므로 여기서 한 번 직접 알려주지 않으면
  // 첫 화면이 영원히 비어 있게 된다.
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    onMove(map)
  }, [map, onMove])

  return null
}

/**
 * 검색 반경 표시.
 *
 * "여기까지 찾았다"를 눈에 보이게 한다. 검색도 이 원 안에서만 하므로 거짓말이 아니다 —
 * 원 밖에 마커가 없는 건 버그가 아니라 거기까진 안 찾았다는 뜻이다.
 *
 * 지도를 가리면 안 되므로 테두리와 중심점만. 재질이 아니라 힌트다.
 * 원은 검색이 끝난 자리에 고정된다 — 지도를 움직이는 동안 따라다니면
 * 아직 찾지도 않은 범위를 찾은 척하게 된다.
 */
function RadiusRing({ radiusM, center }: { radiusM: number; center: [number, number] | null }) {
  if (!radiusM || !center) return null
  return (
    <>
      <Circle
        center={center}
        radius={radiusM}
        pathOptions={{
          // 지도가 시끄러워서 얇고 흐린 선은 그냥 안 보인다. 눈에 걸릴 만큼만 올린다.
          color: '#ff7a18', weight: 2, opacity: 0.7,
          fillColor: '#ff7a18', fillOpacity: 0.05,
          dashArray: '7 7',
        }}
        interactive={false}
      />
      {/* 중심점 — 어디를 기준으로 찾았는지 */}
      <CircleMarker
        center={center}
        radius={3}
        pathOptions={{ color: '#ff7a18', weight: 0, fillColor: '#ff7a18', fillOpacity: 0.7 }}
        interactive={false}
      />
    </>
  )
}

function FlyTo({ center }: { center: [number, number] | null }) {
  const map = useMap()
  const last = useRef<string>('')
  useEffect(() => {
    if (!center) return
    const key = center.join(',')
    if (key === last.current) return
    last.current = key
    map.flyTo(center, Math.max(map.getZoom(), 16), { duration: 0.6 })
  }, [center, map])
  return null
}

/** 클러스터를 누르면 그 자리를 확대한다. 개수만 보이던 곳에서 가격이 드러나야 한다. */
function ClusterLayer({ clusters }: { clusters: Cluster[] }) {
  const map = useMap()
  return (
    <>
      {clusters.map((c, i) => (
        <Marker
          key={`${c.lat},${c.lng},${i}`}
          position={[c.lat, c.lng]}
          icon={clusterIcon(c.count)}
          eventHandlers={{
            click: () => {
              // 한 번에 확 들어가지 않고 두 단계씩 — 어디로 가는지 따라갈 수 있어야 한다
              map.flyTo([c.lat, c.lng], Math.min(map.getZoom() + 2, 18), { duration: 0.5 })
            },
          }}
        />
      ))}
    </>
  )
}

/**
 * 선택된 가게의 카드를 그 포인트 위에 띄운다.
 *
 * react-leaflet의 <Popup>을 쓰지 않는 이유: 선택 상태가 바뀔 때마다 팝업이
 * 다시 열리고 닫히면서 리렌더가 무한히 돌았다. 좌표를 픽셀로 직접 바꿔
 * 절대 위치로 얹으면 생명주기 싸움이 없고 모양도 마음대로 만들 수 있다.
 *
 * 화면 하단에 폭 넓게 띄우지 않는 이유: 어느 가게 것인지 눈으로 잇지 못하고
 * 지도를 통째로 가린다. 카드는 자기 가게 위에 붙어 있어야 한다.
 */
const CARD_W = 228
/** StoreCard가 최대 몇 줄까지 보여주는지 — 높이 추정에 쓴다 */
const MAX_CARD_MENUS = 5

function AnchoredCard({ store, children }: { store: Store; children: React.ReactNode }) {
  const map = useMap()
  // 카드 위치는 지도 상태에서 바로 계산되는 값이라 상태로 둘 필요가 없다.
  // 지도가 움직일 때 다시 그리기만 하면 된다. move는 드래그 중에도 계속 온다.
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useMapEvents({ move: redraw, zoom: redraw })

  const pt = map.latLngToContainerPoint([store.lat, store.lng])
  const size = map.getSize()

  // 좌우: 화면 가장자리에서 카드가 잘리지 않게 안쪽으로 민다
  const half = CARD_W / 2
  const x = Math.min(Math.max(pt.x, half + 8), size.x - half - 8)

  // 위아래: 마커 위에 띄우는 게 기본이지만, 지도 상단에 가까운 마커는 카드가
  // 화면 밖으로 잘린다 (실제로 잘렸다). 그럴 땐 마커 아래로 뒤집는다.
  // 높이는 실측 대신 구성으로 추정한다 — 재려면 렌더 후 상태를 바꿔야 하고
  // 그러면 지도가 움직일 때마다 리렌더가 한 번씩 더 돈다.
  const estHeight = 44 + Math.min(store.menus.length, MAX_CARD_MENUS) * 34
  const flip = pt.y - 36 - estHeight < 0

  return (
    <div
      className="pointer-events-none absolute z-[1000]"
      style={{
        left: x,
        top: flip ? pt.y + 6 : pt.y - 36,
        transform: `translate(-50%, ${flip ? '0' : '-100%'})`,
      }}
    >
      {/* 아래로 뒤집히면 꼬리가 위로 간다 — 꼬리는 항상 마커를 가리켜야 한다 */}
      {flip && (
        <div className="jm-tail jm-tail--up mx-auto" style={{ transform: `translateX(${pt.x - x}px) rotate(45deg)` }} aria-hidden />
      )}
      <div className="pointer-events-auto">{children}</div>
      {!flip && (
        <div className="jm-tail mx-auto" style={{ transform: `translateX(${pt.x - x}px) rotate(45deg)` }} aria-hidden />
      )}
    </div>
  )
}

export default function MapView({
  stores, clusters, selectedId, onSelect, onMove, userLocation, flyTo,
  onLocate, locating, searchedRadius, searchedCenter, renderCard, onPopupClose, view,
}: {
  stores: Store[]
  clusters: Cluster[]
  selectedId: string | null
  /** 마커가 메뉴를 보여줄지 식당을 보여줄지 */
  view: ViewMode
  onSelect: (id: string) => void
  onMove: (map: L.Map) => void
  userLocation: { lat: number; lng: number } | null
  flyTo: [number, number] | null
  onLocate: () => void
  locating: boolean
  /** 실제로 검색이 이뤄진 반경(m)과 그 중심. 검색 전에는 그리지 않는다. */
  searchedRadius: number
  searchedCenter: [number, number] | null
  /** 선택된 가게의 카드. 지도가 아니라 페이지가 카드 내용을 안다. */
  renderCard: (store: Store) => React.ReactNode
  /** 지도 빈 곳을 누르면 카드를 닫는다 */
  onPopupClose: () => void
}) {
  const tile = getTileConfig()
  const selectedStore = stores.find((s) => s.id === selectedId) ?? null

  return (
    <MapContainer
      center={[37.5563, 126.9236]}
      zoom={15}
      className="h-full w-full"
      zoomControl={false}
      // 서울 전역이 대상이지만 지구 반대편까지 스크롤할 이유는 없다
      maxBounds={[[37.35, 126.7], [37.75, 127.25]]}
      minZoom={11}
    >
      <TileLayer url={tile.url} attribution={tile.attribution} maxZoom={tile.maxZoom} />

      {/* 현재 위치 — 지도 우측 상단.
          누를 때마다 1회만 조회한다. 실시간 추적(watchPosition)은 쓰지 않는다:
          위치를 계속 수집하면 위치정보법상 검토가 필요해지고, 처음 위치를 잡거나
          길찾기가 제대로 가고 있는지 확인하는 데는 1회 조회로 충분하다. */}
      <div className="leaflet-top leaflet-right">
        <div className="leaflet-control leaflet-bar !border-0 !bg-transparent !shadow-none">
          <button
            onClick={onLocate}
            disabled={locating}
            aria-label="현재 위치"
            title="현재 위치"
            className="flex size-9 items-center justify-center rounded-full border border-neutral-200 bg-white shadow-md transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-neutral-700"
          >
            <svg
              viewBox="0 0 24 24"
              className={`size-4 ${userLocation ? 'text-blue-600 dark:text-blue-400' : 'text-neutral-600 dark:text-neutral-300'} ${locating ? 'animate-pulse' : ''}`}
              fill="none" stroke="currentColor" strokeWidth="2"
            >
              <circle cx="12" cy="12" r="3.5" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" strokeLinecap="round" />
              <circle cx="12" cy="12" r="8" opacity="0.4" />
            </svg>
          </button>
        </div>
      </div>
      <MapEvents onMove={onMove} onMapClick={onPopupClose} />
      <FlyTo center={flyTo} />
      <RadiusRing radiusM={searchedRadius} center={searchedCenter} />

      {userLocation && (
        <CircleMarker
          center={[userLocation.lat, userLocation.lng]}
          radius={7}
          pathOptions={{ color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }}
        />
      )}

      {/* 멀리서는 개수만, 가까이서는 가격과 메뉴 */}
      <ClusterLayer clusters={clusters} />

      {stores.map((s) => (
        <Marker
          key={s.id}
          position={[s.lat, s.lng]}
          icon={priceIcon(s, s.id === selectedId, view)}
          zIndexOffset={s.id === selectedId ? 1000 : 0}
          eventHandlers={{ click: () => onSelect(s.id) }}
        />
      ))}

      {/* 카드는 선택된 가게 하나만. 마커 위에 붙어서 뜬다. */}
      {selectedStore && (
        <AnchoredCard store={selectedStore}>{renderCard(selectedStore)}</AnchoredCard>
      )}
    </MapContainer>
  )
}
