import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireAdmin } from '@/lib/admin-auth'
import { isValidUserId } from '@/lib/user'

// 어뷰징 대기열.
//
// 자동 감지(정량 규칙 + 선택적 AI)에 걸린 리뷰가 status='pending'으로 쌓이고,
// 걸린 기기는 flag_count가 올라간다. 운영자가 여기서 보고:
//   - 리뷰: approve(정상이었음, 노출)  / reject(스팸 확정, 숨김)
//   - 기기: block(이후 제보·리뷰 거부) / unblock(오판이었음, flag 초기화)
//
// 승인 시 포인트를 준다 — 자동 감지가 오판해 대기로 보냈던 정상 리뷰의 보상을
// 뒤늦게라도 챙겨준다. 작성 시엔 pending이라 포인트가 0이었다.
const REVIEW_POINTS = 10

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req)
  if (denied) return denied

  // 운영자가 처리해야 할 리뷰:
  //   - status='pending'            : 아직 안 뜬 것(gated 정책이거나 검열에 걸린 것) → 승인/거부
  //   - approved인데 points 미지급  : optimistic으로 이미 떠 있으나 포인트 확정 안 된 것 → 확정/내리기
  // 왜 걸렸는지(reason)·현재 상태·어느 메뉴인지 함께 준다. user_id는 사칭 방지로 안 보낸다.
  const pendingReviews = await sql`
    select
      r.id, r.comment, r.flagged_reason as reason, r.rating, r.tags, r.created_at, r.status,
      m.name as menu_name, s.name as store_name, s.district
    from menu_reviews r
    join menus m on m.id = r.menu_id
    join stores s on s.id = m.store_id
    where r.status in ('pending', 'held') or (r.status = 'approved' and not r.points_awarded)
    order by (r.status = 'held') desc, (r.status = 'approved'), r.created_at desc
    limit 200
  `

  // 감지에 걸린 적 있거나 이미 차단된 기기. 마지막으로 무슨 이유로 걸렸는지도.
  const flaggedDevices = await sql`
    select
      u.id, u.flag_count, u.blocked_at,
      (select l.reason from moderation_log l
        where l.user_id = u.id and l.reason is not null
        order by l.created_at desc limit 1) as last_reason,
      (select max(l.created_at) from moderation_log l where l.user_id = u.id) as last_at
    from app_users u
    where u.flag_count > 0 or u.blocked_at is not null
    order by (u.blocked_at is null), u.flag_count desc, last_at desc
    limit 100
  `

  // 감지 로그 — 규칙·AI가 막은 것(reason 있는 것). 채팅에서 막힌 건 어디에도 안 남고
  // 여기에만 있다(채팅은 대기열이 아니라 즉시 차단이라 리뷰처럼 큐에 안 뜬다). 운영자가
  // "무엇을, 왜 막았나"를 보고 오탐을 잡고 반복범 기기를 바로 차단할 수 있게 한다.
  // comment_norm은 정규화(공백·기호 제거)된 텍스트라 원문과 완전히 같진 않지만, 무엇이
  // 막혔는지 파악엔 충분하다. user_id는 admin 전용 화면이고 차단 버튼에 필요해 함께 준다.
  const recentBlocks = await sql`
    select id, target_kind, comment_norm, reason, created_at, user_id
    from moderation_log
    where reason is not null
    order by created_at desc
    limit 100
  `

  return NextResponse.json({ pendingReviews, flaggedDevices, recentBlocks })
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req)
  if (denied) return denied

  let body: { action?: 'block' | 'unblock' | 'approve' | 'hold' | 'reject'; userId?: string; reviewId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  const { action } = body

  // 기기 차단/해제
  if (action === 'block' || action === 'unblock') {
    const userId = body.userId
    if (!isValidUserId(userId)) return NextResponse.json({ error: 'userId가 올바르지 않습니다' }, { status: 400 })
    if (action === 'block') {
      await sql`update app_users set blocked_at = now() where id = ${userId}`
    } else {
      // 해제하면 flag_count도 0으로 — 오판이었으니 다시 대기열에 뜨지 않게.
      await sql`update app_users set blocked_at = null, flag_count = 0 where id = ${userId}`
    }
    return NextResponse.json({ ok: true })
  }

  // 리뷰 승인/반려
  if (action === 'approve' || action === 'hold' || action === 'reject') {
    const reviewId = body.reviewId
    if (!isValidUserId(reviewId)) return NextResponse.json({ error: 'reviewId가 올바르지 않습니다' }, { status: 400 })

    const done = await sql.begin(async (tx) => {
      const [r] = await tx<{ id: string; user_id: string | null; status: string; points_awarded: boolean }[]>`
        select id, user_id, status, points_awarded from menu_reviews where id = ${reviewId} for update
      `
      if (!r) return false

      if (action === 'hold') {
        if (r.status === 'rejected' || r.points_awarded) return false
        await tx`
          update menu_reviews
          set status = 'held', reviewed_at = now(), reviewed_by = 'admin'
          where id = ${reviewId}
        `
        return true
      }

      if (action === 'reject') {
        if (r.status === 'rejected') return false // 이미 내려감
        // 내리기는 승인·지급이 끝난(이미 노출 중인) 리뷰도 반드시 할 수 있어야 한다 —
        // 사후 신고·명예훼손 등 자동검열이 못 본 맥락. 승인+지급됐다고 못 내리면
        // 유해 콘텐츠를 지도에서 뺄 길이 없어진다. 이미 준 포인트는 회수하지 않는다
        // (선의의 기여였고, 내리기는 콘텐츠 제거지 처벌이 아니다).
        await tx`
          update menu_reviews
          set status = 'rejected', reviewed_at = now(), reviewed_by = 'admin'
          where id = ${reviewId}
        `
        return true
      }

      // 승인/확정 — 이미 승인+지급까지 끝났으면 할 일 없음.
      if (r.status === 'approved' && r.points_awarded) return false
      // 원장 유일 키를 먼저 잡고 잔액을 갱신한다. 행 잠금과 함께 재시도 이중 지급을 막는다.
      if (!r.points_awarded && r.user_id) {
        const [user] = await tx<{ points: number }[]>`
          select points from app_users where id = ${r.user_id} for update
        `
        if (user) {
          const nextBalance = user.points + REVIEW_POINTS
          const [ledger] = await tx<{ id: string }[]>`
            insert into point_transactions
              (user_id, amount, reason, reference_type, reference_id, idempotency_key, balance_after)
            values
              (${r.user_id}, ${REVIEW_POINTS}, 'review_approved', 'menu_review', ${reviewId},
               ${'review:' + reviewId}, ${nextBalance})
            on conflict (idempotency_key) do nothing
            returning id
          `
          if (ledger) {
            await tx`update app_users set points = ${nextBalance} where id = ${r.user_id}`
          }
        }
      }
      await tx`
        update menu_reviews
        set status = 'approved', points_awarded = true,
            reviewed_at = now(), reviewed_by = 'admin'
        where id = ${reviewId}
      `
      return true
    })

    if (!done) return NextResponse.json({ error: '이미 처리되었거나 없는 리뷰입니다' }, { status: 409 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'action이 올바르지 않습니다' }, { status: 400 })
}
