'use client'

import { useEffect, useReducer, useRef } from 'react'
import { useMap, useMapEvents } from 'react-leaflet'
import type { Store, ViewMode } from '@/lib/types'
import { placeLabels, leaderStart, type Box } from '@/lib/labels'
import Rating from './Rating'
import { menuIcon } from '@/lib/menuIcon'

// 지도 위 라벨.
//
// 가게 위치는 점이 표시하고, 메뉴 박스는 겹치지 않는 자리로 밀어낸 뒤 인출선으로 잇는다.
// 박스를 가게 위에 그대로 얹으면 (1) 박스끼리 겹쳐 못 읽고 (2) 가게가 어디인지 가려버린다.
//
// Leaflet 마커로 하지 않고 오버레이로 직접 그리는 이유: 배치를 계산하려면 모든 박스의
// 위치를 한꺼번에 알아야 하는데, 마커는 각자 독립적으로 자기 자리에 박힌다.

const ROW_H = 36
const MORE_H = 20
const BOX_W = 168
const MARKER_MENUS = 3

/** 가게 종류를 알려주는 작은 아이콘. 점만 찍으면 뭐가 있는 자리인지 모른다. */
function StoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9h16l-1 11H5L4 9Z" />
      <path d="M4 9l1.2-4.2A1 1 0 0 1 6.2 4h11.6a1 1 0 0 1 1 .8L20 9" />
      <path d="M9.5 13v3M14.5 13v3" />
    </svg>
  )
}

export default function MenuLabels({
  stores, view, selectedMenuId, selectedStoreId, onMenuTap, onStoreTap,
}: {
  stores: Store[]
  view: ViewMode
  selectedMenuId: string | null
  selectedStoreId: string | null
  onMenuTap: (store: Store, menuId: string) => void
  onStoreTap: (store: Store) => void
}) {
  const map = useMap()
  // 라벨 위치는 지도 상태에서 바로 나오는 값이라 상태로 둘 필요가 없다.
  // 지도가 움직일 때 다시 그리기만 하면 된다.
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useMapEvents({ move: redraw, zoom: redraw, resize: redraw })

  // 드래그(화면 이동)를 클릭으로 오인하지 않게 한다.
  //
  // 마커(점·박스·메뉴)는 지도 위에 얹은 오버레이 버튼이라, 끌기 시작점이 마커 위면
  // mousedown→up이 클릭으로 발화돼 "지도만 옮기려던" 동작이 음식점·메뉴 선택으로 샌다.
  // 지도 이동 자체는 이미 Leaflet이 처리하므로(마커는 mousedown을 막지 않는다), 여기선
  // "누른 뒤 뗄 때까지 일정 거리 이상 움직였으면 그 클릭은 드래그였다"고 보고 무시한다.
  // 마우스·터치를 한꺼번에 다루려고 pointer 이벤트를 캡처 단계에서 지켜본다.
  const dragged = useRef(false)
  useEffect(() => {
    const el = map.getContainer()
    let sx = 0, sy = 0, down = false
    const onDown = (e: PointerEvent) => { sx = e.clientX; sy = e.clientY; down = true; dragged.current = false }
    const onMove = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) dragged.current = true
    }
    const onUp = () => { down = false }
    el.addEventListener('pointerdown', onDown, true)
    el.addEventListener('pointermove', onMove, true)
    el.addEventListener('pointerup', onUp, true)
    el.addEventListener('pointercancel', onUp, true)
    return () => {
      el.removeEventListener('pointerdown', onDown, true)
      el.removeEventListener('pointermove', onMove, true)
      el.removeEventListener('pointerup', onUp, true)
      el.removeEventListener('pointercancel', onUp, true)
    }
  }, [map])

  // 마커 탭 핸들러 — 드래그였으면 무시하고, 아니면 지도 클릭(시트 닫힘)으로 새지 않게 막고 실행.
  const tap = (fn: () => void) => (e: React.MouseEvent) => {
    if (dragged.current) return
    e.stopPropagation()
    fn()
  }

  const size = map.getSize()
  // 좁은 화면(모바일)에선 라벨 박스를 작게 잡아 더 많이 배치한다 —
  // 168px 고정폭은 390px 화면의 43%라 몇 개 못 얹고 나머지는 점으로 버려졌다.
  const compact = size.x < 480
  const boxW = compact ? 128 : BOX_W
  const rowsShown = compact ? 2 : MARKER_MENUS
  const bandBottom = size.y < 700 ? 68 : 84

  // 상단 필터 바와 하단 토글이 차지한 자리. 그 밑에 라벨을 놓으면 가려서 안 보인다.
  const reserved: Box[] = [
    { x: 0, y: 0, w: size.x, h: 104 },
    { x: 0, y: size.y - bandBottom, w: size.x, h: bandBottom },
  ]

  const boxSize = (s: Store) => {
    if (view === 'store') return { w: Math.min(boxW, 40 + s.name.length * 12), h: 28 }
    const rows = Math.min(s.menus.length, rowsShown)
    const more = s.menus.length > rowsShown ? MORE_H : 0
    return { w: boxW, h: 6 + rows * ROW_H + more }
  }

  // 싼 것부터 자리를 잡는다 — 자리가 모자라면 비싼 게 밀려나는 게 맞다.
  // 이 서비스는 싼 걸 찾으러 오는 곳이다. (API가 이미 최저가순으로 준다)
  const placements = placeLabels(
    stores,
    (s) => map.latLngToContainerPoint([s.lat, s.lng]),
    boxSize,
    { w: size.x, h: size.y },
    reserved
  )

  return (
    <>
      {/* 인출선 — 박스가 어느 점의 것인지 잇는다.
          흰 halo를 밑에 깔고 그 위에 주황 선을 얹는다. 지도 어디에 떨어질지 모르므로
          색 하나로는 배경에 묻힌다. */}
      <svg className="jm-leader" width={size.x} height={size.y}>
        {placements.map(({ item, anchor, box }) => {
          if (!box) return null
          const from = leaderStart(box, anchor)
          return (
            <g key={item.id}>
              <line className="jm-leader__halo" x1={from.x} y1={from.y} x2={anchor.x} y2={anchor.y} />
              <line className="jm-leader__line" x1={from.x} y1={from.y} x2={anchor.x} y2={anchor.y} />
              <circle cx={from.x} cy={from.y} r={2.5} />
            </g>
          )
        })}
      </svg>

      {/* 가게 위치 점 — 정확한 자리. 박스가 이걸 가리지 않는다.
          라벨 자리를 못 찾은 가게도 점은 찍는다 — 지도에서 사라지면 없는 줄 안다. */}
      {placements.map(({ item, anchor }) => (
        <button
          key={`dot-${item.id}`}
          // 선택된 가게는 시트 스크림(z 1190) 위로 올린다. 그래야 아래 시트가
          // 어느 가게 얘기인지 눈으로 이을 수 있다 — 다 같이 어두워지면 알 수 없다.
          className={`jm-dot absolute ${item.id === selectedStoreId ? 'jm-dot--on z-[1195]' : 'z-[450]'}`}
          style={{ left: anchor.x, top: anchor.y, transform: 'translate(-50%, -50%)' }}
          onClick={tap(() => onStoreTap(item))}
          aria-label={item.name}
        >
          <StoreIcon />
        </button>
      ))}

      {/* 메뉴 박스. 자리를 못 찾았으면 접는다 — 겹쳐서 둘 다 못 읽게 하느니 낫다.
          그 가게는 위의 점으로 남아 있으므로 눌러서 볼 수 있다. */}
      {placements.map(({ item, box }) => box && (
        <div
          key={`box-${item.id}`}
          className={`absolute ${
            item.id === selectedStoreId || item.menus.some((m) => m.id === selectedMenuId)
              ? 'z-[1195]'
              : 'z-[500]'
          }`}
          style={{ left: box.x, top: box.y, width: box.w }}
        >
          {view === 'store' ? (
            <button
              className={`jm-pin w-full ${item.id === selectedStoreId ? 'jm-pin--on' : ''}`}
              onClick={tap(() => onStoreTap(item))}
            >
              <span className="jm-pin__name">{item.name}</span>
              <span className="jm-pin__count">{item.menus.length}</span>
            </button>
          ) : (
            <div className="jm-pin jm-pin--menus">
              {item.menus.slice(0, rowsShown).map((m) => (
                <button
                  key={m.id}
                  // 누른 메뉴만 강조한다. 박스 전체를 두르면 아래 시트엔 메뉴 하나만
                  // 떠 있는데 지도엔 여러 개가 묶여 보여서 뭘 보고 있는지 헷갈린다.
                  className={`jm-row ${m.id === selectedMenuId ? 'jm-row--on' : ''}`}
                  onClick={tap(() => onMenuTap(item, m.id))}
                >
                  {/* 개별 아이콘 → 업종 폴백 → (둘 다 없을 때만) X.
                      한 끼 아닌 메뉴를 걸러내고 폴백까지 붙으면 X는 사실상 안 남는다. */}
                  {menuIcon(m) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="jm-row__img" src={menuIcon(m)!} alt="" loading="lazy" />
                  ) : (
                    <span className="jm-row__img jm-row__img--none">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                        <path d="M7 7l10 10M17 7L7 17" />
                      </svg>
                    </span>
                  )}
                  <span className="jm-row__text">
                    <span className="jm-row__head">
                      <span className="jm-row__name">{m.name}</span>
                      <Rating value={m.rating} count={m.rating_count} />
                    </span>
                    <span className="jm-row__price">
                      {m.price.toLocaleString()}<i>원</i>
                    </span>
                  </span>
                </button>
              ))}
              {item.menus.length > rowsShown && (
                <button
                  className="jm-more"
                  onClick={tap(() => onStoreTap(item))}
                >
                  메뉴 {item.menus.length - rowsShown}개 더
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </>
  )
}
