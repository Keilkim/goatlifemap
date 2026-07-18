import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "갓생맵",
  description: "서울 만원 이하 점심 메뉴 지도 — 착한가격업소 기반",
};

// 지도가 화면 끝까지 깔리는 앱이라 노치·홈 인디케이터 영역까지 그린다(viewport-fit=cover).
// 그래야 하단에 뜬 버튼·시트를 env(safe-area-inset-*)만큼 밀어 기기별 홈 바를 피할 수 있다.
// 이 값이 없으면 safe-area-inset-*은 항상 0이라, 코드 곳곳의 pb-[env(safe-area-inset-bottom)]가
// 아무 일도 하지 않는다.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
