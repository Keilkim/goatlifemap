// 반경 검색을 위한 지리 계산.
//
// PostGIS를 쓰지 않는다. 확장 의존이 없어야 로컬 Postgres와 Supabase가 완전히 같은
// SQL로 돌기 때문이다. 대신 (lat,lng) btree 인덱스를 타는 사각형으로 후보를 좁힌 뒤
// haversine으로 원 밖을 걸러낸다 — 이 규모에서는 충분히 빠르다.

import type { Map as LeafletMap } from 'leaflet'

export const EARTH_R = 6371000

/**
 * 검색 반경(m) — 화면 중심 기준.
 *
 * 화면 가장자리에 딱 붙는 원은 눈에 안 보여서 "여기까지 찾았다"를 말해주지 못한다.
 * 그래서 화면보다 조금 안쪽으로 그린다. 대신 검색도 이 반경으로 한다 —
 * 원은 화면 안쪽인데 검색은 화면 전체로 하면 원 밖에도 마커가 찍혀 원이 거짓말이 된다.
 * 원 밖 여백에 마커가 없는 건 버그가 아니라 "거기까진 안 찾았다"는 뜻이다.
 */
const RADIUS_FILL = 0.82

export function visibleRadius(map: LeafletMap): number {
  const c = map.getCenter()
  const b = map.getBounds()
  const inscribed = Math.min(
    map.distance(c, { lat: b.getNorth(), lng: c.lng }),
    map.distance(c, { lat: c.lat, lng: b.getEast() })
  )
  return inscribed * RADIUS_FILL
}

/** 반경을 사람이 읽는 말로. 도보 분은 성인 보행 67m/분 기준. */
export function radiusLabel(m: number): string {
  const walk = Math.max(1, Math.round(m / 67))
  return m >= 1000 ? `반경 ${(m / 1000).toFixed(1)}km · 도보 ${walk}분` : `반경 ${Math.round(m)}m · 도보 ${walk}분`
}

/** 중심에서 반경 radiusM을 감싸는 최소 사각형. 인덱스 선별용이다. */
export function bboxAround(lat: number, lng: number, radiusM: number) {
  const dLat = (radiusM / EARTH_R) * (180 / Math.PI)
  // 경도 1도의 실거리는 위도에 따라 줄어든다. 서울(위도 37.5)에서는 약 88km/도다.
  const dLng = dLat / Math.max(0.01, Math.cos((lat * Math.PI) / 180))
  return {
    minLat: lat - dLat, maxLat: lat + dLat,
    minLng: lng - dLng, maxLng: lng + dLng,
  }
}
