'use client'

import { useState } from 'react'

// 메뉴 입력 도구.
//
// 공공데이터로 서울 전역 가게 뼈대가 이미 깔려 있으므로, 여기서는 가게를 검색해
// 메뉴 2~3개만 붙이면 된다. 주소를 좌표로 바꾸는 지오코딩이 필요 없다 —
// 공공데이터가 이미 좌표를 갖고 있기 때문이다.
//
// 자동 크롤러를 붙이지 않는 이유는 화면 하단 안내에 적어두었다.

type Store = {
  id: string; name: string; category: string | null
  road_address: string | null; menu_count: number; source: string
}
type Row = { name: string; price: string }

export default function Admin() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Store[]>([])
  const [selected, setSelected] = useState<Store | null>(null)
  const [rows, setRows] = useState<Row[]>([{ name: '', price: '' }, { name: '', price: '' }, { name: '', price: '' }])
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const search = async (e: React.FormEvent) => {
    e.preventDefault()
    if (q.trim().length < 2) return
    setBusy(true)
    try {
      const r = await fetch(`/api/admin/search?q=${encodeURIComponent(q.trim())}`)
      const d = await r.json()
      setResults(d.stores ?? [])
      setSelected(null)
      setMsg(null)
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!selected) return
    const menus = rows
      .filter((r) => r.name.trim() && r.price.trim())
      .map((r) => ({ name: r.name.trim(), price: parseInt(r.price.replace(/[^0-9]/g, ''), 10) }))
    if (!menus.length) { setMsg('메뉴를 입력하세요'); return }

    setBusy(true)
    try {
      const res = await fetch('/api/admin/menus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId: selected.id, menus }),
      })
      const d = await res.json()
      if (!res.ok) { setMsg(d.error); return }
      setMsg(`저장 완료 — ${selected.name}에 메뉴 ${d.menus.length}개`)
      setRows([{ name: '', price: '' }, { name: '', price: '' }, { name: '', price: '' }])
      setResults((prev) => prev.map((s) => (s.id === selected.id ? { ...s, menu_count: d.menus.length } : s)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-8">
      <h1 className="text-xl font-bold text-neutral-900 dark:text-neutral-50">메뉴 입력</h1>
      <p className="mt-1 text-sm text-neutral-500">
        가게를 검색해 대표 메뉴를 붙입니다. 좌표는 공공데이터에 이미 있으므로 입력할 필요가 없습니다.
      </p>

      <form onSubmit={search} className="mt-6 flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="가게명 또는 주소 (2글자 이상)"
          className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-400"
        />
        <button
          disabled={busy}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
        >
          검색
        </button>
      </form>

      {results.length > 0 && !selected && (
        <ul className="mt-4 divide-y divide-neutral-100 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {results.map((s) => (
            <li key={s.id}>
              <button
                onClick={() => { setSelected(s); setMsg(null) }}
                className="block w-full px-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{s.name}</span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {s.category} · 메뉴 {s.menu_count}개
                  </span>
                </div>
                <p className="truncate text-xs text-neutral-500">{s.road_address}</p>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="mt-5 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-semibold text-neutral-900 dark:text-neutral-50">{selected.name}</p>
              <p className="truncate text-xs text-neutral-500">{selected.road_address}</p>
            </div>
            <button onClick={() => setSelected(null)} className="shrink-0 text-xs text-neutral-500 underline">
              다른 가게
            </button>
          </div>

          <div className="mt-4 space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={r.name}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  placeholder={`메뉴 ${i + 1}`}
                  className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
                />
                <input
                  value={r.price}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))}
                  placeholder="가격"
                  inputMode="numeric"
                  className="w-28 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900"
                />
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => setRows([...rows, { name: '', price: '' }])}
              className="text-xs text-neutral-500 underline"
            >
              메뉴 추가
            </button>
            <button
              onClick={save}
              disabled={busy}
              className="ml-auto rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
            >
              저장
            </button>
          </div>
        </div>
      )}

      {msg && (
        <p className="mt-4 rounded-lg bg-neutral-100 px-4 py-2.5 text-sm text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          {msg}
        </p>
      )}

      <div className="mt-10 rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        <p className="font-semibold">메뉴는 왜 자동으로 안 긁어오나</p>
        <p className="mt-1.5">
          저작권법 93조 2항은 개별 소재라도 <strong>반복적·체계적으로 복제</strong>하면 데이터베이스의
          상당한 부분을 복제한 것으로 본다. 잡코리아 v 사람인 사건에서 서울고법은 이를 근거로
          2억 5천만원 배상을 명했다.
        </p>
        <p className="mt-1.5">
          반면 같은 조 4항은 보호가 <strong>&ldquo;소재 그 자체에는 미치지 아니한다&rdquo;</strong>고 한다.
          사람이 개별 가게를 확인해 메뉴명과 가격을 넣는 건 여기에 해당한다.
        </p>
        <p className="mt-1.5">
          그래서 이 도구는 사람이 한 곳씩 확인해 입력하는 방식만 지원한다. 가게 뼈대는 공공데이터
          (공공누리 1유형, 상업적 이용 가능)에서 오므로 문제가 없다. 리뷰·사진·설명문은
          사실 정보가 아니라 저작물일 수 있으니 복제하지 말 것.
        </p>
      </div>
    </main>
  )
}
