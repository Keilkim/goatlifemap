// 기여(리뷰 등)를 지도에 "언제" 반영할지 정하는 정책. 한 곳에 모아 언제든 바꾼다.
//
//   'optimistic' — 우선 반영(approved)하고, 운영자가 나중에 검토·회수(reject)한다.
//                  참여 즉시성이 살고, 관리 화면이 아직 없어도 앱이 돈다. (기본)
//   'gated'      — 운영자 승인 전엔 숨김(pending). 승인해야 지도에 뜬다. 가장 안전하지만
//                  승인 화면(/admin)이 있어야 실제로 작동한다.
//
// 두 가지는 이 정책과 무관하게 항상 고정이다:
//   1) 자동 검열(링크·욕설·도배 등)에 걸린 기여는 정책과 상관없이 항상 보류(pending).
//   2) 포인트는 어느 정책이든 "운영자가 확인한 뒤"에만 지급된다(포인트 파밍 차단).
//
// 바꾸려면 환경변수 MODERATION_MODE=gated 한 줄. 코드 수정 없이 언제든 전환된다.
export type ModerationMode = 'optimistic' | 'gated'

export const MODERATION_MODE: ModerationMode =
  process.env.MODERATION_MODE === 'gated' ? 'gated' : 'optimistic'

/** 검열을 통과한 기여의 초기 상태. 정책에 따라 즉시 노출(approved) 또는 승인 대기(pending). */
export function initialStatus(): 'approved' | 'pending' {
  return MODERATION_MODE === 'gated' ? 'pending' : 'approved'
}
