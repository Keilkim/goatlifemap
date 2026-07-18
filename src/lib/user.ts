import { sql } from '@/lib/db'

// 익명 사용자 식별.
//
// 가입이 없는 서비스라 실계정(Supabase Auth)은 두지 않는다. 브라우저가 만든
// device UUID를 app_users.id로 그대로 쓴다. 어뷰징 방어는 기기 차단 + flag +
// 규칙/LLM 검열 + 레이트리밋으로 한다(user.ts는 신원, moderation.ts는 방어).
//
// 트레이드오프: localStorage를 지우면 새 기기가 되어 차단을 우회한다. 실제 도배가
// 문제되면 그때 IP 레이트리밋이나 실계정으로 올린다 — 지금 단계엔 과하다.
// 그때 갈아타더라도 user_id 컬럼과 아래 시그니처는 그대로 두고 내부만 바꾸면 된다.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidUserId(id: string | null | undefined): id is string {
  return !!id && UUID_RE.test(id)
}

/**
 * device UUID로 사용자를 찾거나 만든다. 없는 id를 보내와도 안전하게 생성한다.
 * blocked: 운영자가 차단한 기기인지. 라우트는 이 값으로 제보·리뷰를 거부한다.
 * points: 이 브라우저 기기에 누적된 현재 포인트.
 */
export async function ensureUser(deviceId: string): Promise<{ id: string; blocked: boolean; points: number }> {
  const [row] = await sql<{ id: string; blocked_at: string | null; points: number }[]>`
    insert into app_users (id) values (${deviceId})
    on conflict (id) do update set id = excluded.id
    returning id, blocked_at, points
  `
  return { id: row.id, blocked: row.blocked_at != null, points: row.points }
}

export const TOGGLE_EXPERIMENT = 'default_view'
export type Variant = 'store_first' | 'menu_first'

/**
 * A/B 그룹 배정.
 *
 * 기본값을 한쪽으로 고정하면 그 보기의 사용량이 당연히 높게 나와서
 * 니즈를 잘못 읽게 된다. 그래서 사용자 절반씩 다른 기본 화면으로 시작시키고,
 * 각 그룹이 "반대 보기로 얼마나 전환하는지"를 비교한다.
 *
 * 한 번 배정되면 재방문해도 같은 그룹을 유지해야 하므로 DB에 고정한다.
 */
export async function assignVariant(userId: string): Promise<Variant> {
  const [existing] = await sql<{ variant: Variant }[]>`
    select variant from ab_assignments
    where user_id = ${userId} and experiment = ${TOGGLE_EXPERIMENT}
  `
  if (existing) return existing.variant

  // device UUID의 첫 바이트로 결정한다. 같은 사용자는 항상 같은 결과가 나온다.
  const variant: Variant = parseInt(userId.replace(/-/g, '').slice(0, 2), 16) % 2 === 0
    ? 'store_first'
    : 'menu_first'

  await sql`
    insert into ab_assignments (user_id, experiment, variant)
    values (${userId}, ${TOGGLE_EXPERIMENT}, ${variant})
    on conflict (user_id, experiment) do nothing
  `
  return variant
}
