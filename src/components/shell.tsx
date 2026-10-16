"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CalendarDays,
  Compass,
  House,
  MapPin,
  PawPrint,
  Plus,
  UserRound,
  ChevronDown,
  X,
  Leaf,
  Search,
} from "lucide-react";
import { useState } from "react";
import { useDemo } from "@/features/demo/provider";
import { Dialog, PetImage } from "./ui";

const nav = [
  { href: "/", name: "首页", sub: "社区日常", icon: House },
  { href: "/discover", name: "附近", sub: "宠友与临时互助", icon: Compass },
  { href: "/posts/new", name: "发布", sub: "发布帖子", icon: Plus },
  { href: "/activities", name: "活动", sub: "一起去撒欢", icon: CalendarDays },
  { href: "/me", name: "我的", sub: "我和毛孩子", icon: UserRound },
];
export function AppShell({ children }: { children: React.ReactNode }) {
  const { state, writable, problem, raw, notice, run, reset, notify } =
      useDemo(),
    path = usePathname(),
    router = useRouter();
  const [switcher, setSwitcher] = useState(false),
    [resetting, setResetting] = useState(false),
    [query, setQuery] = useState("");
  const active = state?.users.find((u) => u.id === state.activeUserId);
  const activeNav = (href: string) =>
    href === "/"
      ? path === "/" || (path.startsWith("/posts/") && path !== "/posts/new")
      : href === "/discover"
        ? path.startsWith("/discover") || path.startsWith("/help")
        : path.startsWith(href);
  const downloadRaw = () => {
    const url = URL.createObjectURL(
      new Blob([raw ?? ""], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "pawmeet-recovery.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <div className="demo-banner">
        <Leaf size={12} />
        <span>本地演示 · 虚构宠友 · 数据仅存当前浏览器</span>
        <span className="demo-version">DEMO</span>
      </div>
      <div className="app-layout">
        <aside className="sidebar">
          <Link href="/" className="brand">
            <span className="brand-mark">
              <PawPrint size={25} fill="currentColor" />
            </span>
            <div>
              PawMeet<small>遇见同频的毛孩子</small>
            </div>
          </Link>
          <div className="sidebar-label">在一起，更快乐</div>
          <nav aria-label="主导航">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={activeNav(n.href) ? "page" : undefined}
                className={activeNav(n.href) ? "nav-item active" : "nav-item"}
              >
                <n.icon size={21} />
                <span>
                  {n.name}
                  <small>{n.sub}</small>
                </span>
                {activeNav(n.href) && <span className="nav-dot" />}
              </Link>
            ))}
          </nav>
          <Link href="/search" className="nav-item">
            搜索帖子与宠友
          </Link>
          <p className="sidebar-foot">每一个小日常，都值得分享。</p>
        </aside>
        <div className={`workspace ${path === "/" ? "home-workspace" : ""}`}>
          <header className="topbar">
            <Link href="/" className="mobile-brand">
              <PawPrint fill="currentColor" size={22} /> PawMeet
            </Link>
            <div className="city">
              <MapPin size={16} />
              <b>杭州 · 滨江</b>
              <span>公共演示区域</span>
            </div>
            <form
              className="global-search"
              onSubmit={(e) => {
                e.preventDefault();
                router.push(`/search?q=${encodeURIComponent(query)}`);
              }}
            >
              <Search size={17} />
              <input
                aria-label="搜索帖子与用户"
                placeholder="搜索帖子、宠友昵称"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd>↵</kbd>
            </form>
            <button
              className="identity"
              disabled={!state}
              onClick={() => setSwitcher(true)}
              aria-label="切换演示身份"
            >
              {active && (
                <PetImage image={active.avatar} alt={active.displayName} />
              )}
              <span>
                {active?.displayName ?? "加载中"}
                <small>模拟身份</small>
              </span>
              <ChevronDown size={14} />
            </button>
          </header>
          <main id="main-content">
            {problem ? (
              <div className="recovery card">
                <h1>需要先处理本地数据</h1>
                <p role="alert">{problem}</p>
                <p>重置会清除当前浏览器修改；数据不会自动覆盖。</p>
                <div className="button-row">
                  {raw !== null && (
                    <button className="button secondary" onClick={downloadRaw}>
                      导出原始数据
                    </button>
                  )}
                  <button
                    disabled={!writable}
                    className="button"
                    onClick={() => setResetting(true)}
                  >
                    重置演示数据
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => location.reload()}
                  >
                    重新读取
                  </button>
                </div>
              </div>
            ) : state ? (
              children
            ) : (
              <div className="loading" role="status">
                <PawPrint size={34} />
                <h2>准备毛茸茸的日常…</h2>
                <div className="skeleton" />
                <div className="skeleton" />
              </div>
            )}
          </main>
          <footer className="footer">
            PawMeet · 让每次相遇，都有温度{" "}
            <span>模拟社区 / 无真实交易或邀约</span>
          </footer>
        </div>
      </div>
      <nav className="bottom-nav" aria-label="移动导航">
        {nav.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={activeNav(n.href) ? "page" : undefined}
            aria-label={n.href === "/posts/new" ? "发布帖子" : undefined}
            className={`${activeNav(n.href) ? "active" : ""} ${n.href === "/posts/new" ? "nav-publish" : ""}`}
          >
            <n.icon size={21} />
            <span>{n.href === "/posts/new" ? "发布" : n.name}</span>
          </Link>
        ))}
      </nav>
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button aria-label="关闭提示" onClick={() => notify("")}>
            <X size={17} />
          </button>
        </div>
      )}
      {switcher && state && (
        <Dialog title="切换演示身份" close={() => setSwitcher(false)}>
          <p className="muted">
            以下均为虚构模拟身份，切换不是登录。所有身份共享当前浏览器的数据。
          </p>
          <div className="switcher-list">
            {state.users
              .filter((u) => u.isSwitchable)
              .map((u) => (
                <button
                  key={u.id}
                  disabled={!writable}
                  className={u.id === state.activeUserId ? "selected" : ""}
                  onClick={() => {
                    if (
                      !window.dispatchEvent(
                        new Event("pawmeet-before-switch", {
                          cancelable: true,
                        }),
                      )
                    )
                      return;
                    if (run({ type: "switch-user", userId: u.id })) {
                      setSwitcher(false);
                      notify(`已切换为 ${u.displayName}（模拟身份）`);
                    }
                  }}
                >
                  <PetImage image={u.avatar} alt={u.displayName} />
                  <span>
                    {u.displayName}
                    <small>
                      {state.pets
                        .filter((p) => p.ownerId === u.id && !p.archivedAt)
                        .map((p) => p.name)
                        .join("、") || "暂无宠物"}
                      的主人 · 模拟身份
                    </small>
                  </span>
                  <span>{u.id === state.activeUserId ? "使用中" : "切换"}</span>
                </button>
              ))}
          </div>
        </Dialog>
      )}
      {resetting && (
        <Dialog title="重置演示数据？" close={() => setResetting(false)}>
          <p>
            当前浏览器新增的档案、名片、互助及清单、动态、活动、关注、点赞和报名，以及上传照片都将清除。恢复
            25 个宠物档案和默认模拟身份。此操作无法撤销。
          </p>
          <div className="button-row">
            <button
              className="button secondary"
              onClick={() => setResetting(false)}
            >
              保留数据
            </button>
            <button
              className="button danger"
              onClick={async () => {
                if (await reset()) setResetting(false);
              }}
            >
              确认重置
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
export function PublishLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link className="button" href={href}>
      <Plus size={17} />
      {children}
    </Link>
  );
}
