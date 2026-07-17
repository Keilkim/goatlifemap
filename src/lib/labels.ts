// 지도 라벨 배치.
//
// 문제: 메뉴 박스를 가게 위치에 그대로 얹으면 (1) 박스끼리 겹쳐서 못 읽고
// (2) 가게가 어디인지 박스가 가려버린다.
//
// 지도 제작의 오래된 해법을 쓴다 — 점은 정확한 자리에 찍고, 라벨은 겹치지 않는
// 자리로 밀어낸 뒤 인출선으로 잇는다.
//
// 알고리즘: 탐욕적 배치. 중요한 것부터(싼 것부터) 후보 자리를 순서대로 시도해
// 이미 놓인 박스와 안 겹치는 첫 자리에 놓는다. 자리를 못 찾으면 그 라벨은 버린다 —
// 겹쳐서 둘 다 못 읽게 만드느니 하나만 보여주는 게 낫다.

export type Box = { x: number; y: number; w: number; h: number }

/** 박스가 놓일 후보 자리. 점을 기준으로 한 오프셋이며, 가까운 순서로 시도한다. */
const CANDIDATES: [number, number][] = [
  [0, -1],    // 위
  [1, -1],    // 오른쪽 위
  [-1, -1],   // 왼쪽 위
  [1, 0],     // 오른쪽
  [-1, 0],    // 왼쪽
  [0, 1],     // 아래
  [1, 1],     // 오른쪽 아래
  [-1, 1],    // 왼쪽 아래
]

/** 점과 박스 사이 최소 간격. 인출선이 보일 만큼은 떨어져야 한다. */
const GAP = 20
/** 박스끼리의 최소 간격 */
const PAD = 6
/** 가게 점의 반지름 + 여유. 남의 점을 박스로 덮지 않기 위한 크기다. */
const DOT_R = 13

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x - PAD < b.x + b.w &&
    a.x + a.w + PAD > b.x &&
    a.y - PAD < b.y + b.h &&
    a.y + a.h + PAD > b.y
  )
}

/**
 * box가 null이면 라벨 자리를 못 찾은 것이다. 그래도 점은 찍어야 한다 —
 * 자리가 없다고 가게를 지도에서 통째로 지우면 데이터를 숨기는 것이고,
 * 사용자는 그 가게가 없는 줄 안다.
 */
export type Placement<T> = { item: T; anchor: { x: number; y: number }; box: Box | null }

/**
 * 라벨 자리 찾기.
 *
 * @param items  배치할 것들. 이미 중요한 순서로 정렬되어 있어야 한다 (싼 것부터).
 * @param anchor 각 항목의 점 위치 (컨테이너 픽셀)
 * @param size   각 항목의 박스 크기
 * @param bounds 화면 크기. 밖으로 나가는 자리는 쓰지 않는다.
 * @param reserved 이미 다른 것이 차지한 영역 (상단 필터 바, 하단 토글 등)
 */
export function placeLabels<T>(
  items: T[],
  anchor: (t: T) => { x: number; y: number },
  size: (t: T) => { w: number; h: number },
  bounds: { w: number; h: number },
  reserved: Box[] = []
): Placement<T>[] {
  const placed: Box[] = [...reserved]
  // 점들도 장애물이다 — 남의 가게 위치를 내 박스로 덮으면 안 된다.
  // 단 자기 자신의 점은 예외다: 인출선으로 이어질 대상이라 가까이 있는 게 정상이고,
  // 장애물로 치면 어느 후보 자리도 통과하지 못해 라벨이 전부 사라진다 (실제로 그랬다).
  const dots: Box[] = items.map((t) => {
    const a = anchor(t)
    return { x: a.x - DOT_R, y: a.y - DOT_R, w: DOT_R * 2, h: DOT_R * 2 }
  })

  const out: Placement<T>[] = []

  for (const [i, item] of items.entries()) {
    const a = anchor(item)
    const others = dots.filter((_, j) => j !== i)
    const { w, h } = size(item)
    // 화면 밖 점은 애초에 라벨을 그릴 이유가 없다
    if (a.x < -50 || a.y < -50 || a.x > bounds.w + 50 || a.y > bounds.h + 50) continue

    let chosen: Box | null = null
    for (const [dx, dy] of CANDIDATES) {
      const box: Box = {
        x: a.x + dx * (w / 2 + GAP) - w / 2,
        y: a.y + dy * (h / 2 + GAP) - h / 2,
      w, h }
      // 화면 밖으로 나가면 다음 후보
      if (box.x < 4 || box.y < 4 || box.x + w > bounds.w - 4 || box.y + h > bounds.h - 4) continue
      if (placed.some((p) => overlaps(box, p))) continue
      if (others.some((d) => overlaps(box, d))) continue
      chosen = box
      break
    }

    // 라벨 자리를 못 찾아도 점은 찍는다. 자리가 없다고 가게를 지도에서 통째로
    // 지우면 데이터를 숨기는 것이고, 사용자는 그 가게가 없는 줄 안다.
    // 겹쳐서 둘 다 못 읽게 하느니 라벨만 접는다.
    if (chosen) placed.push(chosen)
    out.push({ item, anchor: a, box: chosen })
  }

  return out
}

/** 박스 테두리에서 점을 향하는 지점 — 인출선이 박스 안에서 시작하면 지저분하다. */
export function leaderStart(box: Box, to: { x: number; y: number }) {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const dx = to.x - cx
  const dy = to.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  // 박스 중심에서 점 방향으로 나가다가 테두리에 닿는 지점
  const sx = dx === 0 ? Infinity : (box.w / 2) / Math.abs(dx)
  const sy = dy === 0 ? Infinity : (box.h / 2) / Math.abs(dy)
  const s = Math.min(sx, sy)
  return { x: cx + dx * s, y: cy + dy * s }
}
