'use client'

// 팬/필터로 데이터를 받는 짧은 동안 지도 중앙에 뜨는 로딩 표시.
//
// 카테고리 아이콘들이 파도처럼 통통 튀어(뾱뾱뾱) "불러오는 중" 느낌을 준다.
// 빠른 응답에선 깜빡이지 않게, 160ms 뒤에야 서서히 나타난다(그 전에 끝나면 안 보임).
// pointer-events-none이라 밑의 지도 조작은 막지 않는다.

const ICONS = [
  '/icons/cat/korean.png',
  '/icons/cat/japanese.png',
  '/icons/cat/chinese.png',
  '/icons/cat/bunsik.png',
  '/icons/cat/western.png',
]

export default function MapLoading() {
  return (
    <div className="jm-loading pointer-events-none absolute inset-0 z-[1050] grid place-items-center">
      {/* 배경을 살짝 가려 로딩 중임을 알린다 */}
      <div className="absolute inset-0 bg-white/25 backdrop-blur-[1.5px] dark:bg-black/30" />
      <div className="jm-card relative flex items-end gap-1.5 rounded-full px-4 py-3">
        {ICONS.map((src, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={src}
            src={src}
            alt=""
            width={28}
            height={28}
            className="jm-hop size-7 object-contain"
            style={{ animationDelay: `${i * 0.1}s` }}
          />
        ))}
      </div>
    </div>
  )
}
