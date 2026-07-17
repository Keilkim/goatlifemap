# 점심방어

지도를 움직이면 그 동네에서 지금 먹을 수 있는 만원 이하 메뉴가 보이는 서비스.

기존 지도가 "어느 식당에 갈까"에 답한다면, 여기서는 "지금 7,000원으로 뭘 먹을 수 있나"에 답한다.

## MVP가 검증하려는 것

코드가 아니라 이 세 가지가 목표다.

1. 사람들이 만원 이하 메뉴 지도를 실제로 찾는가
2. 식당 단위가 아니라 **메뉴 단위** 검색을 원하는가
3. 정보를 검증해줄 이유가 있는가

특히 2번을 위해 **식당으로 보기 / 메뉴로 보기 토글**을 넣고, 사용자 절반씩 다른 기본 화면으로
시작시킨다. 기본값을 한쪽으로 고정하면 그 보기의 사용량이 당연히 높게 나와 니즈를 오독하기 때문이다.
보는 지표는 토글 클릭 수가 아니라 **각 보기에서 길찾기까지 이어지는 전환율**이다.

## 시작하기

```bash
# 1. Postgres 기동 (Docker 불필요)
/opt/homebrew/opt/postgresql@17/bin/pg_ctl \
  -D ~/.local/share/goatlifemap/pgdata -o "-p 5433" \
  -l ~/.local/share/goatlifemap/pgdata/server.log start

# 2. 스키마
psql -p 5433 -U postgres -h localhost -d jumsim -f supabase/migrations/20260717000001_init.sql

# 3. 데이터 — 둘 중 하나
node scripts/seed-demo.mjs                              # 데모 (홍대·신촌 64곳, 가짜 데이터)
SEOUL_API_KEY=발급키 node scripts/ingest-seoul.mjs        # 진짜 (서울 전역 공공데이터)

# 4. 실행
npm run dev        # http://localhost:3000
                   # http://localhost:3000/admin  메뉴 입력
```

## 알아둘 결정들

### 지오코딩 API는 필요 없다

서울시 일반음식점 인허가 공공데이터에 좌표가 이미 들어있다. 주소를 좌표로 바꿀 일이 없다.

단 좌표계가 **EPSG:5174**(중부원점TM)라 WGS84로 변환해야 한다. EPSG:2097과 헷갈리기 쉬운데,
2097을 쓰면 서울에서 **약 270m 서쪽으로 어긋난다**. 실측으로 확인했다:

| 가게 | EPSG:5174 오차 | EPSG:2097 오차 |
|---|---|---|
| 플루토 (종로구 사직로8길 34) | 28m | 294m |
| 무등산 (성동구 성덕정길 150) | 3m | 269m |

(공공데이터 좌표를 변환해 Nominatim이 반환한 실제 위치와 비교. 2026-07-17)

라이선스는 공공누리 1유형 — **상업적 이용과 변경이 가능**하다. 갱신은 매일.

### 메뉴는 자동으로 긁지 않는다

저작권법 93조 2항은 개별 소재라도 **반복적·체계적으로 복제**하면 데이터베이스의 상당한 부분을
복제한 것으로 본다. 잡코리아 v 사람인에서 서울고법은 이를 근거로 **2억 5천만원 배상**을 명했다.

반면 같은 조 4항은 보호가 **"소재 그 자체에는 미치지 아니한다"**고 한다. 사람이 개별 가게를
확인해 메뉴명과 가격을 넣는 건 여기에 해당한다.

그래서 `/admin`은 사람이 한 곳씩 확인해 입력하는 방식만 지원한다. 가게 뼈대는 공공데이터에서
오므로 문제가 없다. 리뷰·사진·설명문은 사실 정보가 아니라 저작물일 수 있으니 복제하지 말 것.

### 지도 타일

로컬은 OSM 공식 타일. OSM 정책은 소규모 인터랙티브 사용은 허용하지만 **상업 서비스는 예고 없이
차단될 수 있다**고 명시한다. 실서비스로 키울 땐 `NEXT_PUBLIC_VWORLD_KEY`를 넣어 VWorld(국토부,
무료)로 갈아탄다. `src/lib/tiles.ts` 한 곳만 바뀐다.

### PostGIS를 안 쓴다

bbox 조회는 lat/lng btree 범위검색으로 충분하고, 확장 의존이 없어야 로컬과 Supabase가 완전히
같은 SQL로 돈다. 데이터가 커지면 그때 붙여도 늦지 않다.

## Supabase / Vercel로 옮길 때

스키마와 쿼리는 그대로 간다. `supabase/migrations/`의 SQL을 Supabase에 그대로 적용하면 된다.

바꿔야 할 것은 **인증 하나**다.

지금은 브라우저가 만든 device UUID를 `app_users.id`로 쓴다. 이건 **아무 UUID나 만들어 포인트를
무한히 쌓을 수 있다는 뜻**이다. 로컬 테스트에선 괜찮지만 **실제 리워드를 걸기 전에 반드시**
Supabase Anonymous Sign-in으로 갈아타야 한다.

익명 사용자도 `auth.users`에 저장되고 `auth.uid()`가 정상 동작하므로, `user_id` 컬럼 구조와
`src/lib/user.ts`의 함수 시그니처는 그대로 두고 내부만 바뀐다. 그 다음 RLS를 건다.

| | 로컬 (지금) | Supabase (나중) |
|---|---|---|
| 사용자 | device UUID | `signInAnonymously()` → `auth.uid()` |
| 권한 | 앱 코드에서 검사 | RLS 정책 |
| 포인트 조작 방지 | 서버가 포인트표 강제 | + `SECURITY DEFINER` 함수 |
| 신원 사칭 | **막을 수 없음** | JWT로 차단 |

## 구조

```
src/
  app/
    page.tsx              지도 + 토글 + 필터 + 목록
    admin/page.tsx        메뉴 입력
    api/
      stores/             bbox 조회 (가게+메뉴 한 번에)
      session/            익명 사용자 + A/B 배정
      events/             행동 로그
      verify/             검증 제보 + 포인트
      admin/              가게 검색, 메뉴 등록
  components/MapView.tsx  Leaflet. 마커는 식당 단위
  lib/
    coords.ts             EPSG:5174 → WGS84, 거리 계산
    db.ts                 로컬/Supabase 공용 커넥션
    tiles.ts              OSM ↔ VWorld 교체 지점
    user.ts               익명 사용자 + A/B
    analytics.ts          이벤트 큐 + 체류시간
scripts/
  ingest-seoul.mjs        공공데이터 → stores
  seed-demo.mjs           데모 데이터
supabase/migrations/      Supabase에 그대로 적용 가능한 SQL
```

## 검증된 것 / 안 된 것

돌려서 확인함:

- 좌표 변환 정확도 (오차 3~28m)
- 가격·카테고리 필터, bbox 경계
- A/B 배정 균형(47.5:52.5)과 재방문 시 그룹 고정
- 하루 1회 검증 제한 (DB 레벨)
- 포인트 조작 차단 (클라이언트가 999999를 보내도 5P만)
- 품절 제보 → 목록에서 즉시 사라짐
- 브라우저 e2e: 토글 전환, 필터, 마커 렌더, 콘솔 에러 0

아직 안 된 것:

- **서울 전역 실데이터 적재** — `SEOUL_API_KEY` 발급 필요 (현재 데모 데이터 64곳뿐)
- 신원 사칭 방지 — Supabase Auth 이관 전까지 불가
- 구내식당, 북마크, 큐레이터, 쿠폰 — MVP 범위 밖
- 마커 클러스터링 — 서울 전역 실데이터를 넣으면 필요해질 수 있다
