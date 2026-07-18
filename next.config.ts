import type { NextConfig } from "next";

// 보안 헤더 — 전 경로에 적용.
//
// CSP는 지도(maplibre/leaflet, OpenFreeMap 타일)와 카카오 길찾기 iframe이 살아야 해서
// 까다롭다. 이 환경엔 브라우저가 없어 실검증을 못 하므로, 우선 Report-Only로 배포해
// 콘솔 위반을 본 뒤 깨진 소스만 허용에 추가하고, 그다음 헤더 이름을
// 'Content-Security-Policy'로 바꿔 enforcing으로 전환한다(값은 그대로). 나머지 헤더는
// 바로 enforcing해도 안전하다.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:", // 지도 타일·메뉴 아이콘·리뷰 사진
  "font-src 'self'",
  "connect-src 'self' https://tiles.openfreemap.org", // maplibre 스타일/타일 fetch
  "worker-src 'self' blob:", // maplibre 워커
  "frame-src https://map.kakao.com https://*.kakao.com https://*.daumcdn.net", // 길찾기 iframe
  "frame-ancestors 'none'", // 우리 앱을 남이 iframe 못 하게(클릭재킹)
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          // ⚠️ 실브라우저 검증 전까진 Report-Only. 지도·카카오 iframe이 안 깨지는지 확인 후
          //    'Content-Security-Policy'로 키 이름만 바꿔 enforcing 전환.
          { key: "Content-Security-Policy-Report-Only", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
