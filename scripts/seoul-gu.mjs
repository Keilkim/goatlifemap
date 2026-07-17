// 서울 25개 자치구의 LOCALDATA 서비스 코드.
//
// 전역 엔드포인트(LOCALDATA_072404, 535,263건)를 한 번에 받을 수도 있지만,
// 구별로 나눠 받으면 진행상황이 보이고 중간에 실패해도 그 구만 다시 받으면 된다.
//
// 검증(2026-07-17): 아래 25개 구의 list_total_count 합계가 535,263으로
// 전역 엔드포인트 건수와 정확히 일치한다. 빠진 구가 없다는 뜻이다.
// 주의: 동대문구는 DD, 서대문구는 SM, 영등포구는 YD다 (DDM/SDM/YDP가 아니다).

export const SEOUL_GU = [
  { code: 'JN', name: '종로구' },
  { code: 'JG', name: '중구' },
  { code: 'YS', name: '용산구' },
  { code: 'SD', name: '성동구' },
  { code: 'GJ', name: '광진구' },
  { code: 'DD', name: '동대문구' },
  { code: 'JR', name: '중랑구' },
  { code: 'SB', name: '성북구' },
  { code: 'GB', name: '강북구' },
  { code: 'DB', name: '도봉구' },
  { code: 'NW', name: '노원구' },
  { code: 'EP', name: '은평구' },
  { code: 'SM', name: '서대문구' },
  { code: 'MP', name: '마포구' },
  { code: 'YC', name: '양천구' },
  { code: 'GS', name: '강서구' },
  { code: 'GR', name: '구로구' },
  { code: 'GC', name: '금천구' },
  { code: 'YD', name: '영등포구' },
  { code: 'DJ', name: '동작구' },
  { code: 'GA', name: '관악구' },
  { code: 'SC', name: '서초구' },
  { code: 'GN', name: '강남구' },
  { code: 'SP', name: '송파구' },
  { code: 'GD', name: '강동구' },
]
