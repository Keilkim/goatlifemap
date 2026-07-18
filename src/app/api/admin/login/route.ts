import { NextRequest, NextResponse } from 'next/server'
import { checkPassword, setAuthCookie, isAuthed } from '@/lib/admin-auth'
import { clientIp, rateLimit } from '@/lib/ratelimit'

// 로그인 상태 확인
export async function GET(req: NextRequest) {
  return NextResponse.json({ authed: isAuthed(req) })
}

// 비밀번호로 로그인 → 서명 쿠키
export async function POST(req: NextRequest) {
  // 무차별 대입 방어 — 한 IP에서 10분에 10회까지.
  if (!(await rateLimit('admin-login', clientIp(req), 10, 600))) {
    return NextResponse.json({ error: '너무 많은 시도입니다. 잠시 후 다시 시도해주세요' }, { status: 429 })
  }

  let body: { password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  if (!body.password || !checkPassword(body.password)) {
    return NextResponse.json({ error: '비밀번호가 틀렸어요' }, { status: 401 })
  }
  return setAuthCookie(NextResponse.json({ ok: true }))
}
