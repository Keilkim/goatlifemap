'use client'

import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, useMap, useMapEvents, CircleMarker, Circle } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { getTileConfig } from '@/lib/tiles'
import type { Store } from '@/lib/types'
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

function priceIcon(store: Store, selected: boolean) {
  // 가격은 반올림하지 않는다. 3,500원을 "4천"으로 올려 표시하면 실제보다 비싸 보이는데,
  // 싼 메뉴를 찾으러 온 사용자에게 그건 그냥 거짓말이다.
  const price = store.cheapest.toLocaleString()
  const count = store.menus.length
  return L.divIcon({
    className: '',
    html: `
      <div class="jm-marker ${selected ? 'jm-marker--on' : ''}">
        <span class="jm-marker__price">${price}</span>
        ${count > 1 ? `<span class="jm-marker__count">${count}</span>` : ''}
      </div>`,
    iconSize: [64, 30],
    iconAnchor: [32, 30],
  })
}

function MapEvents({ onMove }: { onMove: (map: L.Map) => void }) {
  const map = useMapEvents({
    moveend: (e) => onMove(e.target),
    zoomend: (e) => onMove(e.target),
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

export default function MapView({
  stores, clusters, selectedId, onSelect, onMove, userLocation, flyTo,
  onLocate, locating, searchedRadius, searchedCenter,
}: {
  stores: Store[]
  clusters: Cluster[]
  selectedId: string | null
  onSelect: (id: string) => void
  onMove: (map: L.Map) => void
  userLocation: { lat: number; lng: number } | null
  flyTo: [number, number] | null
  onLocate: () => void
  locating: boolean
  /** 실제로 검색이 이뤄진 반경(m)과 그 중심. 검색 전에는 그리지 않는다. */
  searchedRadius: number
  searchedCenter: [number, number] | null
}) {
  const tile = getTileConfig()

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
      <MapEvents onMove={onMove} />
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
          icon={priceIcon(s, s.id === selectedId)}
          zIndexOffset={s.id === selectedId ? 1000 : 0}
          eventHandlers={{ click: () => onSelect(s.id) }}
        />
      ))}
    </MapContainer>
  )
}
