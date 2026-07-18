import { NextRequest, NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireAdmin } from '@/lib/admin-auth'
import { tmToWgs84 } from '@/lib/coords'
import { isValidUserId } from '@/lib/user'

// 운영자 가게 CRUD.
//
// 대부분의 가게는 공공데이터로 이미 들어와 있으니 추가할 일은 드물다. 하지만 신규
// 개업·누락 가게를 손으로 넣어야 할 때가 있다. 좌표는 두 방법으로 받는다:
//   1) lat/lng 직접 (지도에서 찍은 값)
//   2) 공공데이터 TM 좌표(EPSG:5174) — ingest와 같은 변환을 태운다

// 가게 추가
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req)
  if (denied) return denied

  let body: {
    name?: string; category?: string; road_address?: string; district?: string
    lat?: number; lng?: number; tmX?: number; tmY?: number
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const name = body.name?.trim()
  if (!name) return NextResponse.json({ error: '가게 이름이 필요합니다' }, { status: 400 })

  // 좌표: 직접 위경도 우선, 없으면 TM 좌표를 변환
  let lat = body.lat, lng = body.lng
  if ((lat == null || lng == null) && body.tmX != null && body.tmY != null) {
    const p = tmToWgs84(body.tmX, body.tmY)
    if (!p) return NextResponse.json({ error: 'TM 좌표가 서울 범위를 벗어났습니다' }, { status: 400 })
    lat = p.lat; lng = p.lng
  }
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: '좌표(lat/lng 또는 tmX/tmY)가 필요합니다' }, { status: 400 })
  }

  const row = await sql.begin(async (tx) => {
    await tx`select set_config('app.change_source', 'admin', true)`
    const [created] = await tx`
      insert into stores (name, category, road_address, district, lat, lng, is_open, source)
      values (
        ${name}, ${body.category?.trim() ?? null}, ${body.road_address?.trim() ?? null},
        ${body.district?.trim() ?? null}, ${lat}, ${lng}, true, 'manual'
      )
      returning id, name, lat, lng
    `
    return created
  })
  return NextResponse.json({ ok: true, store: row })
}

// 가게 수정
export async function PATCH(req: NextRequest) {
  const denied = requireAdmin(req)
  if (denied) return denied

  let body: {
    id?: string; name?: string; category?: string; road_address?: string
    lat?: number; lng?: number; is_open?: boolean
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  const id = body.id
  if (!isValidUserId(id)) return NextResponse.json({ error: 'id가 올바르지 않습니다' }, { status: 400 })

  const row = await sql.begin(async (tx) => {
    await tx`select set_config('app.change_source', 'admin', true)`
    const [updated] = await tx`
      update stores set
        name = coalesce(${body.name?.trim() ?? null}, name),
        category = coalesce(${body.category?.trim() ?? null}, category),
        road_address = coalesce(${body.road_address?.trim() ?? null}, road_address),
        lat = coalesce(${body.lat ?? null}, lat),
        lng = coalesce(${body.lng ?? null}, lng),
        is_open = coalesce(${body.is_open ?? null}, is_open),
        updated_at = now()
      where id = ${id}
      returning id, name
    `
    return updated
  })
  if (!row) return NextResponse.json({ error: '없는 가게입니다' }, { status: 404 })
  return NextResponse.json({ ok: true, store: row })
}

// 가게 폐업 처리. 감사·메뉴·제보 이력을 보존하려고 항상 is_open=false로 숨긴다.
export async function DELETE(req: NextRequest) {
  const denied = requireAdmin(req)
  if (denied) return denied

  const id = req.nextUrl.searchParams.get('id')
  const hard = req.nextUrl.searchParams.get('hard') === 'true'
  if (!isValidUserId(id)) return NextResponse.json({ error: 'id가 올바르지 않습니다' }, { status: 400 })
  if (hard) {
    return NextResponse.json({ error: '감사 이력 보존을 위해 영구 삭제는 지원하지 않습니다' }, { status: 400 })
  }

  const changed = await sql.begin(async (tx) => {
    await tx`select set_config('app.change_source', 'admin', true)`
    const [row] = await tx`
      update stores set is_open = false, updated_at = now()
      where id = ${id}
      returning id
    `
    return row
  })
  if (!changed) return NextResponse.json({ error: '없는 가게입니다' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
