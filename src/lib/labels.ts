// 지도 라벨 배치.
//
// 문제: 메뉴 박스를 가게 위치에 그대로 얹으면 (1) 박스끼리 겹쳐서 못 읽고
// (2) 가게가 어디인지 박스가 가려버린다.
//
// 지도 제작의 오래된 해법을 쓴다 — 점은 정확한 자리에 찍고, 라벨은 겹치지 않는
// 자리로 밀어낸 뒤 인출선으로 잇는다.
//
// 알고리즘: 탐욕적 배치. 중요한 것부터(싼 것부터) 후보 자리를 순서대로 시도해
// 이미 놓인 박스와 안 겹치는 첫 자리에 놓는다. 겹치지 않는 자리가 하나도 없으면
// 버리지 않고 '가장 덜 겹치는' 자리에 놓는다 — 모든 가게의 메뉴가 보여야 하기 때문이다.
// (밀집 지역은 약간 겹치지만, 확대하면 자리가 생겨 저절로 벌어진다.)

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

/** 두 박스가 실제로 겹치는 넓이 (안 겹치면 0). 폴백에서 '가장 덜 겹치는' 자리를 고를 때 쓴다. */
function overlapArea(a: Box, b: Box): number {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return ox * oy
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
  const blockers: Box[] = [...reserved]  // strict 검사용: 예약영역 + 이미 놓인 라벨
  const labelBoxes: Box[] = []           // 폴백 겹침넓이 계산용: 라벨 박스만
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
    // 겹침 없는 자리를 못 찾을 때를 대비해 '가장 덜 나쁜' 후보를 함께 고른다.
    let fallback: Box | null = null
    let fallbackPenalty = Infinity
    for (const [dx, dy] of CANDIDATES) {
      const box: Box = {
        x: a.x + dx * (w / 2 + GAP) - w / 2,
        y: a.y + dy * (h / 2 + GAP) - h / 2,
      w, h }
      const off = box.x < 4 || box.y < 4 || box.x + w > bounds.w - 4 || box.y + h > bounds.h - 4
      const hitBlocker = blockers.some((p) => overlaps(box, p))
      const hitDot = others.some((d) => overlaps(box, d))
      if (!off && !hitBlocker && !hitDot) { chosen = box; break }
      // 폴백 점수: 화면 밖·예약영역(필터바/토글)은 강하게 회피, 다른 라벨과의
      // 겹침은 넓이만큼, 남의 점을 덮는 건 중간 페널티.
      let penalty = 0
      if (off) penalty += 1e7
      for (const r of reserved) if (overlaps(box, r)) penalty += 1e6
      for (const lb of labelBoxes) penalty += overlapArea(box, lb)
      if (hitDot) penalty += 3000
      if (penalty < fallbackPenalty) { fallbackPenalty = penalty; fallback = box }
    }

    // 겹치지 않는 자리가 없으면 버리지 않고 가장 덜 겹치는 자리에 놓는다 —
    // 모든 가게의 메뉴가 보여야 한다. (밀집 지역은 확대하면 저절로 벌어진다.)
    const box = chosen ?? fallback
    if (box) { blockers.push(box); labelBoxes.push(box) }
    out.push({ item, anchor: a, box })
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
