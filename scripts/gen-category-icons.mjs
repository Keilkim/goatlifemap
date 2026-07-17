// 카테고리 폴백 아이콘.
//
// 아이콘 없는 메뉴의 88.5%가 "1곳에만 있는 희귀 메뉴"다(갈치조림, 한우 육회 등).
// 이런 걸 하나씩 아이콘 만드는 건 장당 메뉴 1개라 낭비다. 대신 업종별 기본 아이콘을
// 두고, 개별 아이콘이 없으면 그 자리에 X 대신 카테고리 아이콘을 보여준다.
// "사진 없음(X)"보다 "한식 한 그릇" 실루엣이 지도를 덜 휑하게 만든다.
//
// 딱 6장이면 남은 28%를 전부 덮는다.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
} catch { /* .env 없으면 환경변수 */ }

const KEY = process.env.OPENAI_API_KEY
if (!KEY) { console.error('OPENAI_API_KEY 없음'); process.exit(1) }

const OUT = new URL('../public/icons/cat/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

// UI의 category 값(공공데이터 UPTAENM 기반)과 맞춘다.
const CATS = [
  { key: 'korean', label: '한식', desc: 'a simple Korean rice bowl with a spoon, generic home-style meal' },
  { key: 'chinese', label: '중식', desc: 'a bowl of black-bean noodles (jajangmyeon), Korean-Chinese food' },
  { key: 'japanese', label: '일식', desc: 'a pair of nigiri sushi pieces, Japanese food' },
  { key: 'bunsik', label: '분식', desc: 'a paper cup of tteokbokki rice cakes, Korean street snack' },
  { key: 'western', label: '경양식', desc: 'a plate of pork cutlet (donkatsu), Korean-Western food' },
  { key: 'etc', label: '기타', desc: 'a generic plate cover / cloche, unspecified dish' },
]

function prompt(desc) {
  return [
    `A minimal flat vector food icon: ${desc}.`,
    'Single centered object, bold simple shapes, thick clean outlines, flat muted colors.',
    'Slightly desaturated and calm — this is a placeholder, it should not shout.',
    'Legible at 32 pixels: strong silhouette, high contrast, no fine detail.',
    'No text, no letters, no numbers, no watermark, no plate shadow, no background scenery.',
    'Fully transparent background.',
  ].join(' ')
}

for (const cat of CATS) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'gpt-image-1.5',
      prompt: prompt(cat.desc),
      size: '1024x1024', quality: 'low', background: 'transparent', output_format: 'png', n: 1,
    }),
    signal: AbortSignal.timeout(120000),
  })
  const d = await res.json()
  if (d.error) { console.log(`${cat.label} 실패: ${d.error.message}`); continue }
  const path = `${OUT}${cat.key}.png`
  writeFileSync(path, Buffer.from(d.data[0].b64_json, 'base64'))
  execFileSync('sips', ['-Z', '96', path, '--out', path], { stdio: 'ignore' })
  console.log(`  ${cat.label} → /icons/cat/${cat.key}.png`)
}
console.log('완료')
