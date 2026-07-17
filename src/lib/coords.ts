import proj4 from 'proj4'

// 서울시 인허가 공공데이터의 X/Y는 중부원점TM(EPSG:5174)이다.
// EPSG:2097과 헷갈리기 쉬운데, 2097을 쓰면 서울에서 약 270m 서쪽으로 어긋난다.
// 실측 검증(2026-07-17): 공공데이터 좌표를 변환해 Nominatim이 반환한 실제 위치와 비교한 결과
//   플루토(종로구 사직로8길 34): 5174 오차 28m  / 2097 오차 294m
//   무등산(성동구 성덕정길 150): 5174 오차 3m   / 2097 오차 269m
// 두 좌표계의 차이는 중앙자오선 10.405초(약 255m)에서 온다.
const EPSG5174 =
  '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 ' +
  '+ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43'

const WGS84 = '+proj=longlat +datum=WGS84 +no_defs'

/** 서울 대략 경계. 변환이 터무니없는 값을 내면 걸러내기 위한 방어선. */
const SEOUL_BOUNDS = { minLat: 37.4, maxLat: 37.72, minLng: 126.75, maxLng: 127.19 }

export type LatLng = { lat: number; lng: number }

/** 공공데이터 TM 좌표(EPSG:5174) → WGS84 위경도. 변환 실패나 범위 이탈이면 null. */
export function tmToWgs84(x: number, y: number): LatLng | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0 || y === 0) return null
  try {
    const [lng, lat] = proj4(EPSG5174, WGS84, [x, y])
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (
      lat < SEOUL_BOUNDS.minLat || lat > SEOUL_BOUNDS.maxLat ||
      lng < SEOUL_BOUNDS.minLng || lng > SEOUL_BOUNDS.maxLng
    ) return null
    return { lat, lng }
  } catch {
    return null
  }
}

/** 두 지점 사이 직선거리(m). 도보 거리 표시에 쓴다. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** 도보 분 환산. 성인 보행 속도 약 67m/분 기준. */
export function walkMinutes(meters: number): number {
  return Math.max(1, Math.round(meters / 67))
}
