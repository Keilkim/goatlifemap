import { sql } from '@/lib/db'

// 익명 사용자 식별.
//
// 지금: 브라우저가 만든 device UUID를 app_users.id로 그대로 쓴다.
// 나중: Supabase Anonymous Sign-in(signInAnonymously)으로 갈아탄다.
//   Supabase 익명 사용자도 auth.users에 저장되고 auth.uid()가 정상 동작하므로,
//   user_id 컬럼 구조와 아래 함수 시그니처는 그대로 두고 내부만 바뀐다.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidUserId(id: string | null | undefined): id is string {
  return !!id && UUID_RE.test(id)
}

/** device UUID로 사용자를 찾거나 만든다. 없는 id를 보내와도 안전하게 생성한다. */
export async function ensureUser(deviceId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into app_users (id) values (${deviceId})
    on conflict (id) do update set id = excluded.id
    returning id
  `
  return row.id
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
