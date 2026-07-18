// device UUID → 사람이 읽을 수 있는 익명 닉네임("배고픈 너구리").
//
// 익명이되 대화가 누구 것인지 구분은 돼야 한다. UUID를 그대로 노출하면 신원(=기기 id)이
// 새고 사칭도 쉬워지므로, UUID에서 결정적으로 형용사+동물을 뽑는다. 같은 기기는 항상
// 같은 닉이 나오고, 역으로 닉에서 UUID를 되돌릴 수는 없다.
//
// 16 × 16 = 256 조합. 전체 공용 방 한 개 규모엔 충분하다. 지역별로 쪼개지면 방마다
// 인원이 적어져 충돌은 더 드물어진다.
const ADJ = [
  '배고픈', '든든한', '바쁜', '느긋한', '알뜰한', '성실한', '졸린', '신난',
  '수줍은', '용감한', '엉뚱한', '포근한', '씩씩한', '차분한', '재빠른', '까칠한',
]
const ANIMAL = [
  '너구리', '참새', '고양이', '다람쥐', '오리', '여우', '토끼', '수달',
  '판다', '부엉이', '고슴도치', '거북이', '돌고래', '햄스터', '펭귄', '두더지',
]

export function nickname(userId: string): string {
  const hex = userId.replace(/-/g, '')
  const a = parseInt(hex.slice(0, 4), 16) % ADJ.length
  const b = parseInt(hex.slice(4, 8), 16) % ANIMAL.length
  return `${ADJ[a]} ${ANIMAL[b]}`
}
