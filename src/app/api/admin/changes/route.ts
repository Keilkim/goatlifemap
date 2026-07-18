import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireAdmin } from '@/lib/admin-auth'
import { isValidUserId } from '@/lib/user'

type Candidate = {
  id: string
  entity_type: 'store' | 'menu'
  entity_id: string
  event_type: string
  status: 'pending' | 'held' | 'confirmed' | 'rejected'
  source: string
  old_value: { price?: number; is_open?: boolean; is_available?: boolean } | null
  new_value: { price?: number; is_open?: boolean; is_available?: boolean } | null
}

// 수집 변경 후보 + 실제 변경 이력 + 포인트 원장을 한 운영 화면에 제공한다.
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const [candidates, recent, runs, points] = await Promise.all([
    sql`
      select e.id, e.entity_type, e.entity_id, e.store_id, e.menu_id,
             e.event_type, e.status, e.summary, e.old_value, e.new_value,
             e.source, e.detected_at, e.reviewed_at,
             coalesce(s.name, ms.name) as store_name, m.name as menu_name
      from data_change_events e
      left join stores s on s.id = e.store_id
      left join menus m on m.id = e.menu_id
      left join stores ms on ms.id = m.store_id
      where e.status in ('pending', 'held')
      order by (e.status = 'held') desc, e.detected_at asc
      limit 200
    `,
    sql`
      select e.id, e.entity_type, e.event_type, e.status, e.summary, e.source,
             e.detected_at, e.confirmed_at, e.reviewed_at,
             coalesce(s.name, ms.name) as store_name, m.name as menu_name
      from data_change_events e
      left join stores s on s.id = e.store_id
      left join menus m on m.id = e.menu_id
      left join stores ms on ms.id = m.store_id
      where e.status in ('confirmed', 'rejected')
      order by coalesce(e.confirmed_at, e.reviewed_at, e.detected_at) desc
      limit 150
    `,
    sql`
      select id, source, scope, full_snapshot, status, records_seen,
             changes_detected, stats, error_text, started_at, completed_at
      from ingestion_runs
      order by started_at desc
      limit 30
    `,
    sql`
      select p.id, p.user_id, p.amount, p.reason, p.reference_type, p.reference_id,
             p.balance_after, p.created_at
      from point_transactions p
      order by p.created_at desc
      limit 100
    `,
  ])

  return NextResponse.json({ candidates, recent, runs, points })
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req)
  if (denied) return denied

  let body: { id?: string; action?: 'approve' | 'hold' | 'reject'; note?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const { id, action } = body
  if (!isValidUserId(id) || !action || !['approve', 'hold', 'reject'].includes(action)) {
    return NextResponse.json({ error: 'id와 action이 올바르지 않습니다' }, { status: 400 })
  }
  const note = body.note?.trim().slice(0, 500) || null

  const result = await sql.begin(async (tx) => {
    const [event] = await tx<Candidate[]>`
      select id, entity_type, entity_id, event_type, status, source, old_value, new_value
      from data_change_events
      where id = ${id}
      for update
    `
    if (!event || !['pending', 'held'].includes(event.status)) return 'stale'

    if (action === 'hold') {
      await tx`
        update data_change_events
        set status = 'held', reviewed_at = now(), actor = 'admin', decision_note = ${note}
        where id = ${id}
      `
      return 'ok'
    }

    if (action === 'reject') {
      await tx`
        update data_change_events
        set status = 'rejected', reviewed_at = now(), actor = 'admin', decision_note = ${note}
        where id = ${id}
      `
      return 'ok'
    }

    // 실제 현재값 변경은 trigger가 가격 이력을 남긴다. change_candidate_id가 있으므로
    // 이미 존재하는 후보 외에 같은 텍스트 이벤트를 한 줄 더 만들지는 않는다.
    await tx`
      select
        set_config('app.change_source', ${event.source}, true),
        set_config('app.change_candidate_id', ${event.id}, true)
    `

    let changed = false
    if (event.entity_type === 'store') {
      const previousOpen = event.old_value?.is_open
      const open = event.event_type === 'store_reopened'
        ? true
        : event.event_type === 'store_closed'
          ? false
          : null
      if (open !== null && typeof previousOpen === 'boolean') {
        const [row] = await tx`
          update stores set is_open = ${open}, updated_at = now()
          where id = ${event.entity_id} and is_open = ${previousOpen}
          returning id
        `
        changed = !!row
      }
    } else if (event.entity_type === 'menu') {
      if (event.event_type === 'menu_price_changed') {
        const previousPrice = Number(event.old_value?.price)
        const price = Number(event.new_value?.price)
        if (
          Number.isInteger(previousPrice) && previousPrice >= 0 && previousPrice <= 1_000_000
          && Number.isInteger(price) && price >= 0 && price <= 1_000_000
        ) {
          const [row] = await tx`
            update menus set price = ${price}, verified_at = now(), updated_at = now()
            where id = ${event.entity_id} and price = ${previousPrice}
            returning id
          `
          changed = !!row
        }
      } else if (event.event_type === 'menu_removed' || event.event_type === 'menu_restored') {
        const previousAvailable = event.old_value?.is_available
        const available = event.event_type === 'menu_restored'
        if (typeof previousAvailable === 'boolean') {
          const [row] = await tx`
            update menus set is_available = ${available}, verified_at = now(), updated_at = now()
            where id = ${event.entity_id} and is_available = ${previousAvailable}
            returning id
          `
          changed = !!row
        }
      }
    }

    if (!changed) return 'missing'
    await tx`
      update data_change_events
      set status = 'confirmed', reviewed_at = now(), confirmed_at = now(),
          actor = 'admin', decision_note = ${note}
      where id = ${id}
    `
    return 'ok'
  })

  if (result === 'stale') {
    return NextResponse.json({ error: '이미 처리된 변경입니다' }, { status: 409 })
  }
  if (result === 'missing') {
    return NextResponse.json(
      { error: '대상이 없거나 현재값이 달라졌습니다. 새 수집 결과를 확인해주세요' },
      { status: 409 },
    )
  }
  return NextResponse.json({ ok: true })
}
