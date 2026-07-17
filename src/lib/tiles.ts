// 지도 타일 제공자.
//
// 로컬/소규모 테스트: OSM 공식 타일.
//   OSM Tile Usage Policy는 소규모 인터랙티브 사용은 허용하지만
//   "상업 서비스는 예고 없이 차단될 수 있다"고 명시한다. 대량 프리페치는 금지다.
//   → 실서비스로 키우면 반드시 갈아타야 한다.
//
// 배포: VWorld(국토교통부) 무료 WMTS. 한국 지도 품질이 OSM보다 낫다.
//   키 발급: https://www.vworld.kr/dev/v4api.do (무료, 도메인 등록 필요)
//   NEXT_PUBLIC_VWORLD_KEY를 넣으면 자동으로 VWorld를 쓴다.

export type TileConfig = { url: string; attribution: string; maxZoom: number }

export function getTileConfig(): TileConfig {
  const vworldKey = process.env.NEXT_PUBLIC_VWORLD_KEY

  if (vworldKey) {
    return {
      // 주의: VWorld WMTS는 {z}/{y}/{x} 순서다. OSM의 {z}/{x}/{y}와 다르다.
      url: `https://api.vworld.kr/req/wmts/1.0.0/${vworldKey}/Base/{z}/{y}/{x}.png`,
      attribution: '&copy; <a href="https://www.vworld.kr/">VWorld</a> 국토교통부',
      maxZoom: 19,
    }
  }

  return {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }
}
