'use client'

import { useLayoutEffect, useRef, useState } from 'react'

// iOS 세그먼티드 컨트롤.
// 선택된 알약이 스프링으로 미끄러진다. 색만 바뀌면 애플처럼 읽히지 않는다 —
// 움직임이 "여기서 저기로 갔다"는 공간 관계를 만든다.

export default function Segmented<T extends string>({
  options, value, onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null)

  // 알약의 위치는 실제 버튼 크기에서 읽는다. 글자 길이가 바뀌면 알약도 따라가야 한다.
  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const measure = () => {
      const active = el.querySelector<HTMLButtonElement>(`[data-seg="${value}"]`)
      if (!active) return
      setThumb({ x: active.offsetLeft, w: active.offsetWidth })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [value, options])

  return (
    <div ref={wrap} className="jm-segment">
      {thumb && (
        <div
          className="jm-segment__thumb"
          style={{ transform: `translateX(${thumb.x - 2}px)`, width: thumb.w }}
          aria-hidden
        />
      )}
      {options.map((o) => (
        <button
          key={o.value}
          data-seg={o.value}
          onClick={() => onChange(o.value)}
          className={`relative z-10 whitespace-nowrap px-3 py-1 text-[12.5px] font-semibold transition-colors duration-200 ${
            value === o.value
              ? 'text-[#1c1c1e] dark:text-white'
              : 'text-[#3c3c43]/60 dark:text-[#ebebf5]/60'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
