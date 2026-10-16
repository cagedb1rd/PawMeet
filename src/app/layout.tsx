import type { Metadata } from "next";
import { DemoProvider } from "@/features/demo/provider";
import { AppShell } from "@/components/shell";
import "./globals.css";
import "./redesign.css";
export const metadata: Metadata = {
  title: "PawMeet · 遇见同频的毛孩子",
  description: "本地演示宠物社区，一起分享日常、认识宠友、相约散步。",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <a href="#main-content" className="skip-link">
          跳至主要内容
        </a>
        <DemoProvider>
          <AppShell>{children}</AppShell>
        </DemoProvider>
      </body>
    </html>
  );
}
