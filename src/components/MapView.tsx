'use client'

import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, useMap, useMapEvents, CircleMarker } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { getTileConfig } from '@/lib/tiles'
import type { Store } from '@/lib/types'

// 마커는 "식당 단위"로 유지한다.
// 메뉴 단위로 마커를 찍으면 같은 건물에 마커가 겹쳐서 지도가 오히려 못 쓰게 된다.
// 대신 마커 위에 최저가와 조건에 맞는 메뉴 개수를 얹어 메뉴 정보를 노출한다.
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

function MapEvents({ onMove }: { onMove: (b: L.LatLngBounds, zoom: number) => void }) {
  const map = useMapEvents({
    moveend: (e) => onMove(e.target.getBounds(), e.target.getZoom()),
    zoomend: (e) => onMove(e.target.getBounds(), e.target.getZoom()),
  })

  // moveend/zoomend는 사용자가 지도를 움직여야만 발생한다.
  // 최초 로드 때는 아무 이벤트도 안 오므로 여기서 한 번 직접 알려주지 않으면
  // 첫 화면이 영원히 비어 있게 된다.
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    onMove(map.getBounds(), map.getZoom())
  }, [map, onMove])

  return null
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

export default function MapView({
  stores, selectedId, onSelect, onMove, userLocation, flyTo,
}: {
  stores: Store[]
  selectedId: string | null
  onSelect: (id: string) => void
  onMove: (b: L.LatLngBounds, zoom: number) => void
  userLocation: { lat: number; lng: number } | null
  flyTo: [number, number] | null
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
      <MapEvents onMove={onMove} />
      <FlyTo center={flyTo} />

      {userLocation && (
        <CircleMarker
          center={[userLocation.lat, userLocation.lng]}
          radius={7}
          pathOptions={{ color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }}
        />
      )}

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
