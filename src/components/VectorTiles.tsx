'use client'

import { useEffect, useState } from 'react'
import { TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'maplibre-gl/dist/maplibre-gl.css'
import { OPENFREEMAP_STYLE, ATTRIBUTION, RASTER_FALLBACK } from '@/lib/tiles'

// OpenFreeMap Positron 벡터 타일을 Leaflet 지도의 바닥으로 깐다.
//
// 왜 Leaflet을 버리고 MapLibre로 갈아타지 않는가: 우리 지도 코드(인출선 라벨 배치,
// 클러스터, 반경 원, 가게 점)가 전부 Leaflet 좌표계(latLngToContainerPoint)에 붙어 있다.
// 브릿지를 쓰면 바닥만 벡터로 바꾸고 그 위는 그대로 둘 수 있다.

/** WebGL이 되는가. 벡터 타일은 WebGL 없이는 아예 그려지지 않는다. */
function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'))
  } catch {
    return false
  }
}

/**
 * 지도 라벨을 한국어로 고정한다.
 *
 * OpenFreeMap 기본 스타일은 영문과 현지명을 같이 띄워서 "HONGDAE STREET / 홍대거리"처럼
 * 두 줄이 겹쳐 나온다. 한국 사용자에게 영문 지명은 읽을 거리만 늘린다.
 */
function koreanize(style: maplibregl.StyleSpecification): maplibregl.StyleSpecification {
  for (const layer of style.layers) {
    if (layer.type !== 'symbol') continue
    const layout = layer.layout as Record<string, unknown> | undefined
    if (!layout?.['text-field']) continue
    // 한국어가 있으면 한국어, 없으면 원래 이름
    layout['text-field'] = ['coalesce', ['get', 'name:ko'], ['get', 'name']]
  }
  return style
}

export default function VectorTiles() {
  const map = useMap()
  // WebGL 지원 여부는 기기의 성질이라 렌더 중에 한 번 물어보면 된다.
  // effect에서 setState로 정하면 렌더가 한 번 더 돌고, 그 사이 지도가 비어 보인다.
  const [webgl] = useState(hasWebGL)
  // 벡터 로딩이 실패했을 때만 상태가 바뀐다
  const [failed, setFailed] = useState(false)
  const fallback = !webgl || failed

  useEffect(() => {
    if (!webgl) return

    let layer: L.Layer | null = null
    let cancelled = false

    // maplibre-gl-leaflet은 L.maplibreGL을 전역 L에 붙이는 방식이라
    // 브라우저에서만, 그리고 Leaflet이 준비된 뒤에 불러야 한다.
    ;(async () => {
      try {
        const maplibregl = (await import('maplibre-gl')).default
        // 이 플러그인은 window.maplibregl을 찾는다
        ;(window as unknown as { maplibregl: unknown }).maplibregl = maplibregl
        await import('@maplibre/maplibre-gl-leaflet')
        if (cancelled) return

        const style = koreanize(await (await fetch(OPENFREEMAP_STYLE)).json())
        if (cancelled) return

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        layer = (L as any).maplibreGL({
          style,
          attribution: ATTRIBUTION,
          // 지도를 우리가 이미 Leaflet으로 다루므로 MapLibre의 상호작용은 끈다
          interactive: false,
        })
        layer?.addTo(map)
      } catch {
        // 벡터가 안 되면 래스터로라도 바닥을 깐다
        if (!cancelled) setFailed(true)
      }
    })()

    return () => {
      cancelled = true
      if (layer) map.removeLayer(layer)
    }
  }, [map, webgl])

  // WebGL이 없거나 벡터 로딩이 실패한 기기. 지도가 하얀 화면이 되는 것보다는
  // POI가 좀 시끄럽더라도 지도가 보이는 게 낫다.
  if (fallback) {
    return <TileLayer url={RASTER_FALLBACK.url} attribution={RASTER_FALLBACK.attribution} maxZoom={19} />
  }
  return null
}
