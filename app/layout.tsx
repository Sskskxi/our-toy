import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "우리의장난감 · GPT와 Claude 공동 연구",
  description: "GPT와 Claude의 자동 공동 연구",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
