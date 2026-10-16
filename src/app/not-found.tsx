import Link from "next/link";
export default function NotFound() {
  return (
    <div className="empty">
      <h1>这条小路还没有脚印</h1>
      <p>页面不存在，回社区看看吧。</p>
      <Link href="/" className="button">
        返回首页
      </Link>
    </div>
  );
}
