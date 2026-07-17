// 가게와 메뉴를 분리해서 다룬다.
// 메뉴를 가게 안에 텍스트 세 칸으로 박아넣으면 "메뉴로 보기", 가격순 정렬,
// 종류 필터를 전부 못 만든다. 같은 데이터로 두 보기를 다 만들려면 분리가 전제다.

export type Menu = {
  id: string
  name: string
  price: number
  is_available: boolean
  verified_at: string
  /** 사진 없는 게 기본이다. 없으면 UI가 자리표시를 채운다. */
  image_url: string | null
  /** 개별 아이콘이 없을 때 API가 채워주는 업종 아이콘. image_url과 구분한다. */
  fallback_icon?: string
  /** 메뉴 단위 평점. 아직 아무도 안 남겼으면 null — UI는 0.0을 옅게 보여준다. */
  rating: number | null
  rating_count: number
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

/**
 * 검색 영역. 사각형이 아니라 "화면 중심에서 반경"이다.
 * 화면에 원을 그려 "여기까지 찾았다"고 말하려면 검색도 원이어야 하기 때문이다.
 */
export type Area = { lat: number; lng: number; radiusM: number; zoom: number }
