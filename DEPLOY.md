# 배포 (Vercel + Supabase)

로컬에서 돌던 걸 그대로 올린다. 스키마는 PostGIS 같은 확장에 의존하지 않아 Supabase에서 그대로 돈다.

## 0. 배포 전 필수
- [ ] **관리자 비밀 재발급** — 이 채팅/로컬에 있던 `ADMIN_PASSWORD`·`ADMIN_SECRET`은 버리고 새로 만든다.
  ```sh
  openssl rand -base64 24   # ADMIN_PASSWORD
  openssl rand -base64 48   # ADMIN_SECRET
  ```
- [ ] **`public/icons/*.png` 커밋 확인** — 메뉴 아이콘(약 160개)이 `image_url=/icons/…`로 참조된다. 정적 파일이라 커밋돼 있어야 Vercel이 함께 배포한다. (`git status`로 확인)
- [ ] `.env`는 절대 커밋하지 않는다(이미 gitignore). 비밀은 Vercel 프로젝트 설정에만.

## 1. Supabase 프로젝트
1. supabase.com → New project. 리전은 서울과 가까운 곳(예: Singapore/Tokyo).
2. **Connect** 버튼에서 두 문자열을 복사해 둔다:
   - **Direct**(포트 5432, `db.[ref].supabase.co`) — 마이그레이션·데이터 적재용.
   - **Transaction 풀러**(포트 6543, `…pooler.supabase.com`) — **런타임(Vercel)용**.

## 2. 스키마 적용 (Direct 연결)
```sh
DATABASE_URL='postgres://postgres:[비번]@db.[ref].supabase.co:5432/postgres' \
  node scripts/migrate.mjs
```
`schema_migrations`가 적용 파일을 기록하므로 재실행해도 끝난 백필을 다시 돌리지 않는다. 새 파일만
트랜잭션으로 적용되며 앱 테이블에는 RLS가 켜진다.

## 3. 데이터 적재 (가게·메뉴)
스키마만으론 지도가 빈다. 로컬의 가게·메뉴를 옮긴다. **2번(스키마) 이후**에 실행.
```sh
# 로컬에서 덤프 (부모→자식 순서로 나온다)
pg_dump 'postgres://postgres@localhost:5433/jumsim' --data-only --no-owner \
  --table=public.stores --table=public.menus --table=public.menu_price_history > seed.sql
# Supabase에 적재 (Direct 연결)
psql 'postgres://postgres:[비번]@db.[ref].supabase.co:5432/postgres' -f seed.sql
```
> 대안: `SEOUL_API_KEY`를 Supabase DATABASE_URL로 두고 `node scripts/ingest-seoul.mjs`부터 다시 돌린다(느림). 리뷰·제보·채팅·기기 테이블은 비운 채 시작한다(정상).

착한가격업소 메뉴를 새로 확인하려면 Direct 연결로 실행한다.

```sh
DATABASE_URL='postgres://postgres:[비번]@db.[ref].supabase.co:5432/postgres' \
  npm run ingest:goodprice
```

이 명령은 원천 전체를 확인하지만, 기존 확정값과 다른 가격·단종·폐업은 곧바로 덮지 않고
`/admin`의 **변경** 탭에 후보로 쌓는다. `--dry`·`--limit`·실패 실행은 사라짐 판정에 쓰지 않는다.
자동 반복은 아래 **6. 수집 자동화**(GitHub Actions)에서 설정한다.

## 4. Vercel
1. Vercel → New Project → 이 레포 연결. 프레임워크는 Next.js 자동 감지(별도 설정 불필요).
2. **Environment Variables** (`.env.example` 참고):
   | 키 | 값 |
   |---|---|
   | `DATABASE_URL` | **Transaction 풀러**(6543) 문자열 ← 직접 연결 아님 |
   | `OPENAI_API_KEY` | 아이콘 생성 + 텍스트 검열용 |
   | `ADMIN_PASSWORD` | 0번에서 새로 만든 값 |
   | `ADMIN_SECRET` | 0번에서 새로 만든 값 |
   | `MODERATION_MODE` | (선택) `gated`면 승인 전 숨김. 기본 optimistic |
   | `MODERATION_AI` | (선택) `off`면 LLM 검열 끔 |
   | `MODERATION_AI_MODEL` | (선택) 기본 `gpt-4.1-nano` |
3. Deploy.

> **왜 풀러(6543)냐**: Vercel 서버리스는 함수 인스턴스가 우수수 뜬다. 각자 DB에 직접 연결하면 Supabase 커넥션 상한을 금방 넘겨 터진다. Transaction 풀러(pgBouncer)가 이를 다중화한다. `db.ts`가 `pooler`/`:6543`을 감지해 `prepare:false`로 자동 맞춘다(풀러는 prepared statement 미지원).

## 5. 배포 후 점검
- [ ] `/` 지도가 뜨고 마커가 보인다(데이터 적재 확인).
- [ ] `/admin` 로그인 → 새 비밀번호로 됨.
- [ ] `/admin` 변경 탭에서 수집 실행·후보·확정 이력이 보이고 승인/보류/거부가 됨.
- [ ] `/admin` 포인트 탭에서 지급 사유·시각·잔액이 보임.
- [ ] 리뷰/채팅 한 번 남겨 검열·저장이 도는지.
- [ ] Supabase → Database → Roles/Connections에서 커넥션 수가 안정적인지(풀러 확인).

## 6. 수집 자동화 (GitHub Actions)
수집은 수 분짜리 배치라 Vercel 함수(타임아웃)엔 안 맞아 **GitHub Actions**로 돌린다. 워크플로 2개가
`.github/workflows/`에 있다: `ingest-goodprice.yml`(매월 1일), `ingest-seoul.yml`(매월 2일). 둘 다 GitHub
Actions 탭에서 **수동 실행(Run workflow)**도 된다.

설정:
1. 레포를 GitHub에 push (아직 원격이 없으면 `git remote add origin …` 후 push). Actions는 push된 레포에서만 돈다.
2. Repo → **Settings → Secrets and variables → Actions**에 시크릿 추가:
   - `DATABASE_URL_DIRECT` = Supabase **직접 연결**(5432, `db.[ref].supabase.co`). ⚠️ 풀러(6543) 아님 — 배치는 임시테이블·advisory lock을 써서 직접 연결이 맞다.
   - `SEOUL_API_KEY` = 서울 열린데이터광장 인증키(seoul 워크플로용).
3. 첫 실행은 Actions 탭에서 수동(Run workflow)으로 돌려 결과를 확인한 뒤 스케줄에 맡긴다.

> 자동 실행이어도 지도는 안 바뀐다 — 수집기는 차이를 **후보(data_change_events pending)**로만 쌓고,
> `/admin` 변경 탭에서 관리자가 승인해야 반영된다(이상 감지 방식). cron 주기는 워크플로 파일에서 조절.

## 알아둘 것
- **검열 비용**: 채팅은 규칙 통과 메시지마다 설정된 소형 모델을 부른다. 정확한 비용은 사용 모델의
  최신 가격표로 확인하고, 급증하면 `MODERATION_AI=off`로 규칙만 쓸 수 있다.
- **RLS**: 앱은 PostgREST(anon key)를 안 쓴다. RLS는 anon key가 새도 테이블이 안 열리게 하는 이중 안전장치다(우리 직접 연결은 우회).
- **함수 타임아웃**: Vercel Hobby는 기본 10초. 채팅+AI+DB는 그 안에 든다. 길어지면 Pro로 올리거나 `maxDuration`을 설정.
- **채팅 보존**: 서버가 새 메시지마다 최신 100개만 남기고 자동 삭제한다(무한증가 없음).
- **CSP는 Report-Only로 나감**: `next.config.ts`가 CSP를 `Content-Security-Policy-Report-Only`로 보낸다(지도·카카오 iframe이 안 깨지는지 실브라우저로 확인 전이라). 배포 후 브라우저 콘솔에 CSP 위반이 없고 (a)지도 타일 (b)카카오 길찾기 iframe (c)위치 버튼이 정상이면, 헤더 키를 `Content-Security-Policy`로 바꿔 **enforcing 전환**. 위반이 뜨면 그 소스만 허용에 추가. 나머지 헤더(X-Frame-Options 등)는 이미 enforcing.
- **레이트리밋 정리(GC)**: IP 레이트리밋은 `rate_limits` 테이블(고정 창)에 쌓인다. 오래된 창을 주기적으로 지운다. Supabase SQL Editor에서 pg_cron:
  ```sql
  select cron.schedule('gc-rate-limits', '*/10 * * * *',
    $$delete from rate_limits where window_start < now() - interval '1 hour'$$);
  ```
  (pg_cron 확장은 Supabase Dashboard → Database → Extensions에서 켠다. 없으면 Vercel Cron 라우트로 대체.)
