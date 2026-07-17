import postgres from 'postgres'

// 로컬은 직접 띄운 Postgres 17(포트 5433), 배포는 Supabase 커넥션 문자열.
// 같은 SQL이 양쪽에서 그대로 돌도록 확장 의존 없이 작성한다.
const connectionString =
  process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/jumsim'

// Next.js dev의 hot reload가 커넥션 풀을 매번 새로 만들지 않도록 전역에 고정한다.
const globalForDb = globalThis as unknown as { sql?: ReturnType<typeof postgres> }

export const sql =
  globalForDb.sql ??
  postgres(connectionString, {
    max: 10,
    // Supabase는 TLS를 요구하고 로컬은 아니다. 커넥션 문자열로 판별한다.
    ssl: connectionString.includes('supabase') ? 'require' : false,
  })

if (process.env.NODE_ENV !== 'production') globalForDb.sql = sql
