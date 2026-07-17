// 가게와 메뉴를 분리해서 다룬다.
// 메뉴를 가게 안에 텍스트 세 칸으로 박아넣으면 "메뉴로 보기", 가격순 정렬,
// 종류 필터를 전부 못 만든다. 같은 데이터로 두 보기를 다 만들려면 분리가 전제다.

export type Menu = {
  id: string
  name: string
  price: number
  is_available: boolean
  verified_at: string
}

export type Store = {
  id: string
  name: string
  category: string | null
  road_address: string | null
  lat: number
  lng: number
  source: string
  menus: Menu[]
  cheapest: number
}

/** 메뉴로 보기에서 쓰는, 가게 정보가 붙은 평평한 메뉴 카드 */
export type MenuRow = Menu & {
  storeId: string
  storeName: string
  category: string | null
  lat: number
  lng: number
  distance: number | null
}

export type ViewMode = 'store' | 'menu'
