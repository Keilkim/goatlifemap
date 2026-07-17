// 지도 바닥.
//
// OSM 기본 타일은 상점·박물관·카페 아이콘이 잔뜩 박혀 있어서 그 위에 얹은 메뉴 박스와
// 인출선이 배경에 묻힌다. 채도 필터로는 못 고친다 — 아이콘은 타일 이미지에 구워져 있어서
// 색만 죽을 뿐 사라지지 않는다. 바닥 자체를 바꿔야 하는 문제였다.
//
// OpenFreeMap Positron을 쓴다:
//   - 완전 무료, 요청 수 제한 없음, API 키 불필요 (가입도 쿠키도 없음)
//   - 상업적 이용 허용 (공식 FAQ에 명시)
//   - MIT 라이선스, attribution 필수
//   - Positron 스타일: 도로와 지명만 남기고 POI를 걷어낸 회색 바닥
//
// 검토했다가 뺀 것들:
//   CARTO Positron — 같은 스타일이지만 "For commercial purposes, you will need an
//     Enterprise license"라고 공식 문서에 명시되어 있다. 이 서비스는 상업용이다.
//   VWorld — 무료에 한국 지도 품질이 좋지만 키 발급이 필요하다. 나중에 한국 지명이
//     더 필요해지면 후보다.
//   Google Maps — 뷰어로 쓰는 것 자체는 되지만, 우리 지도 코드(인출선 배치, 클러스터,
//     반경 원, 가게 점)가 전부 Leaflet 좌표계에 붙어 있어 통째로 다시 짜야 한다.
//     지도 로드마다 과금되는 것도 있다. 바닥 하나 바꾸자고 치를 값이 아니다.

export const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron'

export const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">© OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>'

/**
 * WebGL이 없는 기기용 바닥.
 *
 * 벡터 타일은 WebGL 없이는 아예 안 그려진다 — 지도가 통째로 하얘진다.
 * POI 아이콘이 좀 시끄럽더라도 지도가 보이는 게 안 보이는 것보다 낫다.
 */
export const RASTER_FALLBACK = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}
