import postgres from 'postgres'

// 로컬은 직접 띄운 Postgres 17(포트 5433), 배포는 Supabase.
// 같은 SQL이 양쪽에서 그대로 돌도록 확장(PostGIS 등) 의존 없이 작성한다.
const connectionString =
  process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/jumsim'

const isSupabase = connectionString.includes('supabase')

// Vercel 서버리스에선 Supabase Transaction 풀러(pgBouncer, 포트 6543, 호스트에 'pooler')를
// 써야 한다 — 함수 인스턴스가 우수수 떠서 각자 DB에 직접 연결하면 커넥션 상한을 금방 넘긴다.
// 그 풀러는 prepared statement를 지원하지 않으므로 prepare:false가 필수다.
// (트랜잭션 풀링이라 sql.begin 같은 트랜잭션은 그대로 된다 — 세션 상태만 못 쓴다.)
const isPooler = connectionString.includes('pooler') || connectionString.includes(':6543')

// Next.js dev의 hot reload가 커넥션 풀을 매번 새로 만들지 않도록 전역에 고정한다.
const globalForDb = globalThis as unknown as { sql?: ReturnType<typeof postgres> }

export const sql =
  globalForDb.sql ??
  postgres(connectionString, {
    // 서버리스 인스턴스마다 이만큼 잡는다. 풀러 뒤라 작게 유지한다.
    max: isSupabase ? 3 : 10,
    // Supabase는 TLS를 요구하고 로컬은 아니다. 커넥션 문자열로 판별한다.
    ssl: isSupabase ? 'require' : false,
    // 풀러(트랜잭션 모드)면 prepared statement 금지.
    prepare: !isPooler,
    // 유휴 연결은 20초 뒤 닫아 커넥션을 오래 쥐지 않는다(서버리스에 유리).
    idle_timeout: 20,
  })

if (process.env.NODE_ENV !== 'production') globalForDb.sql = sql
