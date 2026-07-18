import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireAdmin } from '@/lib/admin-auth'
import { isValidUserId } from '@/lib/user'

// 승인 시 제보자에게 주는 포인트. 제출 즉시가 아니라 여기(운영자 확인 후)서만 지급된다.
const POINTS: Record<string, number> = {
  price_ok: 5,
  still_selling: 5,
  price_changed: 20,
  discontinued: 20,
  sold_out: 20,
}

// 제보 대기열.
//
// 사용자가 낸 가격 변경·단종 제보가 status='pending'으로 쌓여 있다. 운영자가 여기서
// 보고 승인하면 그때 지도에 반영된다 — 승인 없이 허위 제보가 지도를 바꾸지 못하게.

// 대기 중인 제보 목록. 같은 메뉴에 제보가 여럿이면 묶어서 "3명이 8,000원이라고 함"처럼
// 보여줘야 판단이 쉽다.
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const rows = await sql`
    select
      v.id, v.kind, v.reported_price, v.created_at, v.status, v.points_awarded,
      m.id as menu_id, m.name as menu_name, m.price as current_price,
      s.name as store_name, s.district
    from menu_verifications v
    join menus m on m.id = v.menu_id
    join stores s on s.id = m.store_id
    where v.status in ('pending', 'held')
       or (v.status = 'approved' and not v.points_awarded)
    order by (v.status = 'held') desc, v.created_at asc
    limit 200
  `
  return NextResponse.json({ reports: rows })
}

// 제보 승인/반려.
//   approve: 가격 변경이면 이력 쌓고 현재 가격 교체, 단종이면 메뉴 내림.
//   reject:  아무것도 안 바꾸고 상태만 rejected로. 잘못된 제보 표시.
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req)
  if (denied) return denied

  let body: { id?: string; action?: 'approve' | 'hold' | 'reject' }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  const { id, action } = body
  if (!isValidUserId(id) || !action || !['approve', 'hold', 'reject'].includes(action)) {
    return NextResponse.json({ error: 'id와 action이 필요합니다' }, { status: 400 })
  }

  const handled = await sql.begin(async (tx) => {
    const [v] = await tx<
      { id: string; menu_id: string; user_id: string | null; kind: string; reported_price: number | null; status: string; points_awarded: boolean }[]
    >`select id, menu_id, user_id, kind, reported_price, status, points_awarded from menu_verifications where id = ${id} for update`
    // 정책 변경 전 제보는 제출 즉시 포인트를 받았지만 가격/단종 상태 반영은 아직 pending일
    // 수 있다. 그런 legacy 행은 승인·보류·거부는 허용하되 아래 추가 지급만 생략한다.
    if (!v || v.status === 'rejected' || (v.status === 'approved' && v.points_awarded)) return false

    if (action === 'hold') {
      await tx`
        update menu_verifications
        set status = 'held', reviewed_at = now(), reviewed_by = 'admin'
        where id = ${id}
      `
      return true
    }

    if (action === 'reject') {
      await tx`
        update menu_verifications
        set status = 'rejected', reviewed_at = now(), reviewed_by = 'admin'
        where id = ${id}
      `
      return true
    }

    // 승인
    await tx`
      select
        set_config('app.change_source', 'user_report', true),
        set_config('app.verification_id', ${id}, true)
    `
    if (v.kind === 'price_changed' && v.reported_price != null) {
      const [m] = await tx<{ price: number }[]>`select price from menus where id = ${v.menu_id} for update`
      if (m && m.price !== v.reported_price) {
        // 가격 이력과 통합 텍스트 이력은 DB trigger가 같은 트랜잭션에서 남긴다.
        await tx`
          update menus set price = ${v.reported_price}, verified_at = now(), updated_at = now()
          where id = ${v.menu_id}
        `
      }
    } else if (v.kind === 'discontinued' || v.kind === 'sold_out') {
      // 단종 — 메뉴를 내린다. 삭제가 아니라 숨김이라 오판이면 되돌릴 수 있다.
      await tx`update menus set is_available = false, updated_at = now() where id = ${v.menu_id}`
    } else if (v.kind === 'price_ok') {
      await tx`update menus set verified_at = now(), updated_at = now() where id = ${v.menu_id}`
    } else if (v.kind === 'still_selling') {
      await tx`
        update menus set is_available = true, verified_at = now(), updated_at = now()
        where id = ${v.menu_id}
      `
    }

    // 원장에 먼저 유일 키를 잡고 잔액을 올린다. 같은 승인 요청이 재시도되어도 원장 unique와
    // 제보 행 잠금이 함께 막아 포인트가 두 번 늘지 않는다.
    const amount = POINTS[v.kind] ?? 0
    if (!v.points_awarded && v.user_id && amount > 0) {
      const [user] = await tx<{ points: number }[]>`
        select points from app_users where id = ${v.user_id} for update
      `
      if (user) {
        const nextBalance = user.points + amount
        const [ledger] = await tx<{ id: string }[]>`
          insert into point_transactions
            (user_id, amount, reason, reference_type, reference_id, idempotency_key, balance_after)
          values
            (${v.user_id}, ${amount}, ${'verification:' + v.kind}, 'menu_verification', ${id},
             ${'verification:' + id}, ${nextBalance})
          on conflict (idempotency_key) do nothing
          returning id
        `
        if (ledger) {
          await tx`update app_users set points = ${nextBalance} where id = ${v.user_id}`
        }
      }
    }

    await tx`
      update menu_verifications
      set status = 'approved', points_awarded = true,
          reviewed_at = now(), reviewed_by = 'admin'
      where id = ${id}
    `
    return true
  })

  if (!handled) {
    return NextResponse.json({ error: '이미 처리되었거나 없는 제보입니다' }, { status: 409 })
  }
  return NextResponse.json({ ok: true })
}
