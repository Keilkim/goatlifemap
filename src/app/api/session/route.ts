import { NextRequest, NextResponse } from 'next/server'
import { ensureUser, isValidUserId, assignVariant } from '@/lib/user'

// 브라우저가 만든 device UUID를 받아 사용자를 만들고 A/B 그룹을 확정한다.
// 그룹 배정을 서버에서 하는 이유: 클라이언트에서 결정하면 사용자가 조작할 수 있고,
// 재방문 시 같은 그룹이 유지된다는 보장이 없다.
export async function POST(req: NextRequest) {
  let body: { deviceId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  if (!isValidUserId(body.deviceId)) {
    return NextResponse.json({ error: 'invalid deviceId' }, { status: 400 })
  }

  const userId = await ensureUser(body.deviceId)
  const variant = await assignVariant(userId)

  return NextResponse.json({ userId, variant })
}
