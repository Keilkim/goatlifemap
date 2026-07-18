// supabase/migrations/*.sql 를 파일명 순서대로 DATABASE_URL에 적용한다.
//
// 로컬·Supabase 어디든 같은 명령으로:
//   DATABASE_URL='postgres://…' node scripts/migrate.mjs
//
// Supabase에 처음 적용할 땐 "직접 연결" 문자열(포트 5432)을 쓴다 — 마이그레이션은
// 여러 문장을 한 번에 돌리므로 트랜잭션 풀러(6543)보다 직접 연결이 안전하다.
// 배포 런타임(Vercel)의 DATABASE_URL은 반대로 풀러(6543)를 쓴다(README/DEPLOY 참고).
//
// 적용 이력(schema_migrations)을 남겨 이미 끝난 파일은 다시 실행하지 않는다.
// ALTER/백필은 `if not exists`만으로 멱등이 되지 않는다. 특히 포인트 지급 여부 같은
// 데이터 마이그레이션을 재실행하면 실제 지급 없이 처리 완료로 바뀔 수 있다.

import postgres from 'postgres'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL이 필요합니다. 예: DATABASE_URL=… node scripts/migrate.mjs')
  process.exit(1)
}

// prepare:false + max:1 — 마이그레이션은 다중 문장을 simple query로 순차 실행한다.
const sql = postgres(url, {
  ssl: url.includes('supabase') ? 'require' : false,
  prepare: false,
  max: 1,
})

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
console.log(`${files.length}개 마이그레이션을 확인합니다 → ${url.replace(/:[^:@/]+@/, ':****@')}\n`)

await sql.begin(async (tx) => {
  // 빈 DB에서 두 runner가 동시에 pg_class에 같은 테이블을 만들려는 catalog race도 막는다.
  await tx`select pg_advisory_xact_lock(hashtext('goatlifemap:schema-migrations'))`
  await tx`
    create table if not exists schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `
})

// 이전 runner는 적용 이력을 남기지 않았다. 이미 운영 중인 DB에서 새 runner를 처음
// 실행할 때는 각 파일이 만든 대표 객체/컬럼을 보고 과거 파일만 기준선으로 등록한다.
// 이렇게 해야 오래된 백필 SQL을 한 번 더 실행하지 않는다. 깨끗한 DB는 전부 false라
// 아래 기준선이 비고, 모든 마이그레이션이 정상 순서로 적용된다.
const [{ n: tracked }] = await sql`select count(*)::int as n from schema_migrations`
if (tracked === 0) {
  const [legacy] = await sql`
    select
      to_regclass('public.stores') is not null
        and to_regclass('public.menus') is not null
        and to_regclass('public.app_users') is not null as init,
      exists (select 1 from information_schema.columns where table_schema='public' and table_name='stores' and column_name='district') as district,
      exists (select 1 from information_schema.columns where table_schema='public' and table_name='menus' and column_name='image_url') as menu_image,
      to_regclass('public.stores_name_trgm_idx') is not null as goodprice,
      to_regclass('public.menu_reviews') is not null as menu_reviews,
      exists (select 1 from information_schema.columns where table_schema='public' and table_name='menu_reviews' and column_name='rating') as rating,
      to_regclass('public.menu_price_history') is not null
        and exists (select 1 from information_schema.columns where table_schema='public' and table_name='menu_verifications' and column_name='status') as admin_ops,
      to_regclass('public.moderation_log') is not null
        and exists (select 1 from information_schema.columns where table_schema='public' and table_name='app_users' and column_name='blocked_at') as moderation,
      to_regclass('public.chat_messages') is not null as chat,
      exists (select 1 from information_schema.columns where table_schema='public' and table_name='menu_reviews' and column_name='points_awarded')
        and exists (select 1 from information_schema.columns where table_schema='public' and table_name='menu_verifications' and column_name='points_awarded') as points,
      (select count(*) = 10 from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname = any(array[
          'app_users','stores','menus','menu_reviews','menu_verifications',
          'menu_price_history','moderation_log','chat_messages','ab_assignments','events'
        ]) and c.relrowsecurity) as rls,
      to_regclass('public.rate_limits') is not null as rate_limits
  `

  const legacyFiles = [
    ['20260717000001_init.sql', legacy.init],
    ['20260717000002_add_district.sql', legacy.district],
    ['20260717000003_menu_image.sql', legacy.menu_image],
    ['20260717000004_goodprice.sql', legacy.goodprice],
    ['20260717000005_menu_reviews.sql', legacy.menu_reviews],
    ['20260717000006_rating.sql', legacy.rating],
    ['20260718000001_admin_ops.sql', legacy.admin_ops],
    ['20260718000002_moderation.sql', legacy.moderation],
    ['20260718000003_chat.sql', legacy.chat],
    ['20260718000004_points_awarded.sql', legacy.points],
    ['20260718000005_rls.sql', legacy.rls],
    ['20260718000006_rate_limits.sql', legacy.rate_limits],
  ].filter(([, present]) => present).map(([filename]) => filename)

  if (legacyFiles.length) {
    await sql`
      insert into schema_migrations ${sql(legacyFiles.map((filename) => ({ filename })), 'filename')}
      on conflict (filename) do nothing
    `
    console.log(`기존 DB 기준선: ${legacyFiles.length}개 파일을 적용 완료로 확인했습니다.\n`)
  }
}

const appliedRows = await sql`select filename from schema_migrations`
const applied = new Set(appliedRows.map((r) => r.filename))

for (const f of files) {
  if (applied.has(f)) {
    console.log(`▹ ${f} — 이미 적용됨`)
    continue
  }
  process.stdout.write(`▸ ${f} … `)
  try {
    let concurrentlyApplied = false
    await sql.begin(async (tx) => {
      // 두 배포가 동시에 시작해도 한 파일의 DDL과 적용 이력 기록을 직렬화한다.
      await tx`select pg_advisory_xact_lock(hashtext('goatlifemap:schema-migrations'))`
      const [already] = await tx`select filename from schema_migrations where filename = ${f}`
      if (already) {
        concurrentlyApplied = true
        return
      }
      await tx.unsafe(readFileSync(join(dir, f), 'utf8'))
      await tx`insert into schema_migrations (filename) values (${f})`
    })
    console.log(concurrentlyApplied ? '동시 실행에서 이미 적용됨' : 'ok')
  } catch (e) {
    console.log('실패')
    console.error(`\n${e.message}\n`)
    await sql.end()
    process.exit(1)
  }
}

await sql.end()
console.log('\n✓ 필요한 마이그레이션 적용 완료')
