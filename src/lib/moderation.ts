import { sql } from './db'

// 텍스트 어뷰징 감지.
//
// 설계 원칙: "정량적 계산이 먼저, AI는 애매한 것만."
//   1) 링크·전화번호  — 광고의 가장 강한 신호. 정규식으로 공짜로 잡는다.
//   2) 복붙 도배       — 같은 문구를 여러 메뉴에 뿌리는 것. 정규화 텍스트를
//                        moderation_log와 대조해서 잡는다. API 안 쓴다.
//   3) 욕설 사전       — 변형(ㅅㅂ, 시1발 …)까지 잡으려고 글자만 남겨 대조한다.
//   4) AI(선택)        — 채팅·리뷰 코멘트는 규칙 통과분도 가벼운 모델에 물어본다.
//                        다른 호출부는 soft signal이 있을 때만 쓸 수 있다. 키가 있으면
//                        켜지고, 실패하면 정상 사용자를 막지 않도록 통과시킨다.
//
// 완벽한 필터가 아니다. 작정한 어뷰저는 문구를 계속 바꿔 우회한다. 목표는
// "장난 도배의 대부분을 값싸게 막고, 애매한 건 운영자 대기열로 보내는" 것이다.

export type ModReason = 'link' | 'phone' | 'dup' | 'profanity' | 'ai'

export type ModVerdict = {
  /** flag면 리뷰를 pending으로 두고 운영자가 본다. */
  action: 'allow' | 'flag'
  reason: ModReason | null
  /** 정규화 텍스트. moderation_log에 남겨 다음 복붙 감지의 근거가 된다. */
  norm: string | null
}

// ── 정규화 ────────────────────────────────────────────────────────────────
// canonical: 공통 전처리. NFKC(전각→반각·호환 자모 통합) + 제로폭 문자 제거.
//   전각 숫자 전화번호(０１０…), "시‍발" 같은 제로폭 삽입 우회를 여기서 무력화한다.
const ZERO_WIDTH = /[​-‍⁠﻿]/g
function canonical(text: string): string {
  return text.normalize('NFKC').replace(ZERO_WIDTH, '')
}

// norm: canonical 위에서 공백·문장부호·기호를 다 떼고 소문자로. "살짝 바꿔 도배"해도 같은 값.
// letters: norm에서 숫자까지 뗀 것. 시1발 → 시발 처럼 숫자 끼운 욕설을 잡으려고.
function normalize(text: string): string {
  return canonical(text).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}
function lettersOnly(norm: string): string {
  return norm.replace(/[0-9]/g, '')
}

// loose: 링크·전화 우회 방어용. canonical 위에서 공백만 걷어낸다(점·@·숫자는 유지).
// "w w w . e x a m p l e . com", 띄어쓴 010 번호, 전각 숫자를 잡는다.
function looseForm(text: string): string {
  return canonical(text).replace(/\s+/g, '').toLowerCase()
}

// ── 1) 링크 ──────────────────────────────────────────────────────────────
// http(s)/www, 흔한 TLD 도메인, 그리고 메신저 유인("카톡 아이디…", "@핸들").
const LINK_RE = /(https?:\/\/|www\.)/i
const DOMAIN_RE = /[a-z0-9가-힣-]+\.(com|co\.kr|net|kr|org|io|me|shop|xyz|link|kakao\.com)\b/i
// '텔레'는 텔레비전·텔레파시에, 'dm'은 admin·handmade에 걸리므로 쓰지 않는다.
// 전체 단어(텔레그램/텔그)와 경계가 있는 dm(\bdm\b)만 잡는다.
const MESSENGER_RE = /(카톡|카카오톡|오픈채팅|오픈카톡|텔레그램|텔그|라인아이디|디엠|\bdm\b|@[a-z0-9._]{3,})/i
function checkLink(text: string): ModReason | null {
  return LINK_RE.test(text) || DOMAIN_RE.test(text) || MESSENGER_RE.test(text) ? 'link' : null
}

// ── 2) 전화번호 ──────────────────────────────────────────────────────────
// 010/011/016~019 + 구분자(공백·점·하이픈) 허용. 광고에 박히는 연락처.
const PHONE_RE = /01[016789][\s.\-]?\d{3,4}[\s.\-]?\d{4}/
function checkPhone(text: string): ModReason | null {
  return PHONE_RE.test(text) ? 'phone' : null
}

// ── 3) 욕설 사전 ─────────────────────────────────────────────────────────
// 완전한 사전이 아니라 시작점이다. 자모 변형(ㅅㅂ, ㅄ)과 대표 욕만 넣었다.
// letters(숫자·기호 제거) 위에서 부분일치로 본다 — 시 1 발, 개~새끼도 걸린다.
// 부분일치라 일상어와 겹치는 것은 뺐다(정직한 한국어에서 흔히 나오는 것):
//   보지/자지 → "보지 못했어요"·"자지 못했어", 꺼져 → "불이 꺼져 있어요",
//   시바 → "시바견", 새끼 → "새끼 고양이", 걸레 → "걸레질".
// 이들이 진짜 욕/음란으로 쓰인 경우는 맥락을 보는 LLM이 잡는다(채팅은 전 메시지 검사).
const PROFANITY = [
  // 욕설
  '시발', '씨발', '씨바', '싯팔', '씨팔', 'ㅅㅂ', 'ㅆㅂ',
  '병신', 'ㅂㅅ', 'ㅄ', '지랄', '개새끼', '개새', '좆', '좃',
  '엿먹', '닥쳐', 'fuck', 'shit',
  // 음란·성적 (명백한 것만. 맥락형·변형은 LLM이 본다)
  '창녀', '섹스', '야동', '자위', '변태',
]
function checkProfanity(letters: string): ModReason | null {
  return PROFANITY.some((w) => letters.includes(w)) ? 'profanity' : null
}

// ── 4) 복붙 도배 ─────────────────────────────────────────────────────────
// 짧고 흔한 감상("맛있어요")이 반복되는 건 정상이다. 그래서 어느 정도 긴
// 문구(norm 10자 이상)만 본다. 두 가지를 잡는다:
//   - 같은 사용자가 같은 문구를 여러 번(SELF_REPEAT) → 본인 도배
//   - 같은 문구가 여러 사용자에게서(GLOBAL_REPEAT) → 조직적 살포
const DUP_MIN_LEN = 10
const SELF_REPEAT = 3
const GLOBAL_REPEAT = 5
// 대조 창은 24시간 고정. 사용자 입력이 아니라 코드 상수라 쿼리에 그대로 박는다.
async function checkDup(userId: string, norm: string): Promise<ModReason | null> {
  if (norm.length < DUP_MIN_LEN) return null

  const [self] = await sql<{ n: number }[]>`
    select count(*)::int as n from moderation_log
    where user_id = ${userId} and comment_norm = ${norm}
      and created_at > now() - interval '24 hours'
  `
  if (self.n >= SELF_REPEAT) return 'dup'

  const [global] = await sql<{ n: number }[]>`
    select count(distinct user_id)::int as n from moderation_log
    where comment_norm = ${norm}
      and created_at > now() - interval '24 hours'
  `
  if (global.n >= GLOBAL_REPEAT) return 'dup'

  return null
}

// ── 5) AI(선택) ──────────────────────────────────────────────────────────
// 위 규칙이 다 통과했는데도 "냄새나는" 것만 물어본다. 냄새 = 정규식이 놓친
// soft signal: @핸들 비슷한 것, 긴 숫자열, 같은 글자 4연속 등. 이게 없으면
// 대부분의 평범한 리뷰는 AI를 아예 안 거친다(비용 0).
//
// 프로젝트가 이미 OpenAI를 쓰므로(아이콘 생성) 같은 스택을 재사용한다.
// OPENAI_API_KEY가 있으면 기본 켜짐 — 끄려면 MODERATION_AI=off. 어떤 오류든 통과(fail-open).
const SOFT_SIGNAL_RE = /(@[a-z0-9._]{2,}|\d{4,}|(.)\2{3,})/i
function hasSoftSignal(text: string): boolean {
  return SOFT_SIGNAL_RE.test(text)
}

// 이 한 자리 분류 방식에서는 추론 토큰을 쓰는 nano보다 비추론 nano가 더 빠르고 안정적이다.
// 실제 한국어 광고/정상 문구로 확인했으며 env로 언제든 교체할 수 있다.
const AI_MODEL = process.env.MODERATION_AI_MODEL || 'gpt-4.1-nano'
async function checkAI(text: string, always: boolean): Promise<ModReason | null> {
  // "무료 규칙 + 초저가 LLM"을 택했으므로 키가 있으면 기본 켬. 끄려면 MODERATION_AI=off.
  if (!process.env.OPENAI_API_KEY || process.env.MODERATION_AI === 'off') return null
  // 채팅·리뷰처럼 방어가 중요한 호출부는 always=true로 규칙 통과분을 전부 검사한다.
  if (!always && !hasSoftSignal(text)) return null

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      // 애매한 한 줄이 부적절한지만 판단. 토큰을 아끼려고 답을 한 글자로 강제한다.
      body: JSON.stringify({
        model: AI_MODEL,
        // 일부 모델은 한 토큰에서 숫자 대신 잘린 문자를 낼 수 있어 3토큰의 작은 여유를 둔다.
        max_tokens: 3,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              '너는 한국어 게시글/채팅 필터다. 광고·홍보·연락처 유도, 욕설, 음란·성적 표현, 혐오, 도배 중 하나라도 해당하면 ASCII 숫자 "1" 하나만, 평범한 정상 글이면 ASCII 숫자 "0" 하나만 출력한다. 설명하지 마라.',
          },
          // 현재 자유 입력 최대는 채팅 300자·리뷰 200자라 메시지 전체를 본다.
          { role: 'user', content: text.slice(0, 300) },
        ],
      }),
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const answer = String(data?.choices?.[0]?.message?.content ?? '').trim()
    return answer.startsWith('1') ? 'ai' : null
  } catch {
    // 타임아웃·네트워크·파싱 실패 — 정상 사용자를 막지 않는다. 정량 규칙이 이미 1차로 걸렀다.
    return null
  }
}

// ── 공개 API ────────────────────────────────────────────────────────────
/**
 * 코멘트 한 줄을 검사하고 moderation_log에 흔적을 남긴다.
 * 로그는 다음 제출의 복붙 감지에 쓰이므로, 통과한 것도(reason=null) 기록한다.
 * text가 없으면 검사할 것도 없으니 로그도 남기지 않는다.
 */
export async function moderateComment(
  userId: string,
  text: string | null,
  targetKind: 'review' | 'verification' | 'chat',
  opts?: { aiAlways?: boolean },
): Promise<ModVerdict> {
  if (!text) return { action: 'allow', reason: null, norm: null }

  const norm = normalize(text)
  const letters = lettersOnly(norm)
  const loose = looseForm(text) // 링크·전화 우회(띄어쓰기·전각) 방어용 — 규칙이 잡게

  const reason: ModReason | null =
    checkLink(loose) ??
    checkPhone(loose) ??
    checkProfanity(letters) ??
    (await checkDup(userId, norm)) ??
    (await checkAI(text, opts?.aiAlways ?? false))

  await sql`
    insert into moderation_log (user_id, target_kind, comment_norm, reason)
    values (${userId}, ${targetKind}, ${norm}, ${reason})
  `

  return { action: reason ? 'flag' : 'allow', reason, norm }
}
