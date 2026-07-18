import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'

// /admin 잠금.
//
// 초기에는 운영자(너) 혼자 쓰므로 역할·계정 시스템을 만들 이유가 없다. 환경변수
// 비밀번호 하나로 /admin 전체를 잠근다. 로그인하면 서명된 쿠키를 주고, 이후 요청은
// 그 서명만 검증한다 — 비밀번호를 매번 주고받지 않는다.
//
// 서명에 쓰는 시크릿과 비밀번호는 .env에만 둔다 (ADMIN_PASSWORD, ADMIN_SECRET).
// NEXT_PUBLIC_ 접두사를 붙이면 브라우저 번들에 실려 아무나 본다 — 절대 붙이지 않는다.

const COOKIE = 'jm_admin'

function secret(): string | null {
  // ADMIN_SECRET 우선, 없으면 비밀번호로 대신 서명. 둘 다 없으면 null —
  // 이때는 어떤 쿠키도 유효하지 않다(fail-closed). 과거엔 고정 상수로 폴백했는데,
  // 그 상수는 소스에 박혀 있어 env를 빠뜨린 배포에선 아무나 쿠키를 위조할 수 있었다.
  return process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || null
}

/** 로그인 토큰. 만료 시각을 서명에 포함해 위조·연장을 막는다. */
export function makeToken(): string {
  const s = secret()
  // 로그인은 checkPassword(ADMIN_PASSWORD 필요)를 먼저 통과해야 하므로 여기 오면 s는 있다.
  if (!s) throw new Error('ADMIN_SECRET 또는 ADMIN_PASSWORD가 설정되지 않았습니다')
  const exp = Date.now() + 1000 * 60 * 60 * 12 // 12시간
  const sig = createHmac('sha256', s).update(String(exp)).digest('hex')
  return `${exp}.${sig}`
}

function verifyToken(token: string | undefined): boolean {
  const s = secret()
  if (!s || !token) return false // 시크릿이 없으면 어떤 토큰도 유효하지 않다
  const [expStr, sig] = token.split('.')
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < Date.now()) return false
  const expected = createHmac('sha256', s).update(expStr).digest('hex')
  // 타이밍 공격을 피하려고 상수시간 비교
  const a = Buffer.from(sig ?? '', 'hex')
  const b = Buffer.from(expected, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 비밀번호가 맞는가. 상수시간 비교로 길이·내용 유출을 막는다. */
export function checkPassword(input: string): boolean {
  const real = process.env.ADMIN_PASSWORD
  if (!real) return false
  const a = Buffer.from(input)
  const b = Buffer.from(real)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function setAuthCookie(res: NextResponse): NextResponse {
  res.cookies.set(COOKIE, makeToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  })
  return res
}

/** admin API 라우트 맨 앞에서 부른다. 인증 안 됐으면 401 응답을 돌려준다. */
export function requireAdmin(req: NextRequest): NextResponse | null {
  // CSRF 방어(defense-in-depth): Origin 헤더가 있으면 우리 호스트와 같아야 한다.
  // sameSite=lax가 이미 크로스사이트 POST 쿠키 전송을 막지만, Origin 체크를 한 겹 더 둔다.
  // (Origin이 없는 요청 — 일부 GET 내비게이션 — 은 통과시키고 쿠키 검증에 맡긴다.)
  const origin = req.headers.get('origin')
  if (origin) {
    let sameHost = false
    try { sameHost = new URL(origin).host === req.headers.get('host') } catch { sameHost = false }
    if (!sameHost) return NextResponse.json({ error: '잘못된 요청' }, { status: 403 })
  }
  if (verifyToken(req.cookies.get(COOKIE)?.value)) return null
  return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 })
}

export function isAuthed(req: NextRequest): boolean {
  return verifyToken(req.cookies.get(COOKIE)?.value)
}
