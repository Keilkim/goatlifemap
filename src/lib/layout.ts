// 하단 시트냐, 우측 패널이냐.
//
// 지도가 화면 전부인 모바일에선 정보가 아래에서 올라온다. 하지만 화면이 넓고 가로로
// 누우면(데스크톱·가로 태블릿·가로로 돌린 폰) 아래에서 올라오는 시트는 지도의 가로를
// 통째로 덮어 아깝다 — 옆에 세로 기둥으로 세우면 지도와 정보를 나란히 볼 수 있다.
//
// 판정은 "충분히 넓거나 가로로 누웠나" 하나다:
//   - 폭 1024px 이상        → 데스크톱 (방향 무관)
//   - 폭 768px 이상 + 가로  → 가로 태블릿 / 큰 폰 가로
// 그 아래(세로 폰·세로 태블릿·아주 좁은 창)는 지금처럼 하단 시트.
//
// 이 문자열은 globals.css의 `@custom-variant side`와 반드시 같은 조건이어야 한다.
// 레이아웃(클래스)은 CSS가, 슬라이드 방향(아래냐 옆이냐)은 이 값을 읽는 JS가 정한다.
export const SIDE_PANEL_MEDIA =
  '(min-width: 1024px), (min-width: 768px) and (orientation: landscape)'

/** 지금 우측 패널 모드인가. 시트가 열리는 순간의 슬라이드 축을 고르는 데 쓴다. */
export function isSidePanel(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(SIDE_PANEL_MEDIA).matches
}

/** 시트 진입 애니메이션의 시작 오프셋. 하단이면 아래에서, 우측 패널이면 옆에서. */
export function sheetEnterKeyframes(): [string, string] {
  return isSidePanel()
    ? ['translateX(100%)', 'translateX(0%)']
    : ['translateY(100%)', 'translateY(0%)']
}
