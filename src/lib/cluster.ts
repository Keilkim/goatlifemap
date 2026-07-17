// 클러스터링 기준.
//
// 줌아웃 상태에서 가격 마커를 수백 개 뿌리면 서로 겹쳐서 아무것도 못 읽는다.
// 그 거리에서 사용자가 알고 싶은 건 "얼마인가"가 아니라 "여기 몇 곳 있나"다.
// 가까이 가면 그때 가격과 메뉴가 필요해진다.

/**
 * 이 줌 미만이면 개수만 보여준다.
 *
 * Leaflet 줌 15는 대략 동네 하나가 화면에 들어오는 배율이다. 그보다 멀어지면
 * 가격 칩끼리 겹치기 시작한다. 실제 데이터로 확인해 정한 값이다.
 */
export const CLUSTER_ZOOM = 15

/**
 * 줌 레벨에 맞는 격자 크기(도 단위).
 *
 * 줌이 1 내려갈 때마다 화면에 담기는 거리가 2배가 되므로 격자도 2배로 키운다.
 * 그래야 화면상 클러스터 개수가 대략 일정하게 유지된다.
 * 줌 14에서 약 0.01도(≈1.1km)가 눈에 편했다.
 */
export function gridSizeForZoom(zoom: number): number {
  return 0.01 * Math.pow(2, Math.max(0, 14 - zoom))
}

export type Cluster = { lat: number; lng: number; count: number; cheapest: number }
