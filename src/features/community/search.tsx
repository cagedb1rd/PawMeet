"use client";
import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search as SearchIcon } from "lucide-react";
import { useDemo } from "@/features/demo/provider";
import { Empty, PetImage } from "@/components/ui";
import { communityPosts } from "@/domain/community";
import { PostFeed } from "./community";

export function Search() {
  const params = useSearchParams();
  return (
    <SearchResults
      key={params.get("q") ?? ""}
      initialQuery={(params.get("q") ?? "").slice(0, 100)}
    />
  );
}
function SearchResults({ initialQuery }: { initialQuery: string }) {
  const [query, setQuery] = useState(initialQuery);
  const { state } = useDemo();
  if (!state) return null;
  const term = query.trim().toLocaleLowerCase();
  const posts = term ? communityPosts(state, false, term) : [];
  const users = term
    ? state.users.filter((u) =>
        u.displayName.toLocaleLowerCase().includes(term),
      )
    : [];
  return (
    <section className="community-home">
      <Link href="/" className="back-link">
        ← 返回首页
      </Link>
      <h1>搜索</h1>
      <label className="community-search">
        <SearchIcon size={20} />
        <input
          autoFocus
          aria-label="搜索帖子或用户"
          maxLength={100}
          placeholder="帖子标题、内容或宠友昵称"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button onClick={() => setQuery("")} aria-label="清空搜索">
            清空
          </button>
        )}
      </label>
      <p className="form-hint" role="status">
        {term
          ? `找到 ${posts.length} 篇帖子、${users.length} 位用户`
          : "搜索帖子和宠友"}
      </p>
      {users.length > 0 && (
        <>
          <h2 className="subheading">用户</h2>
          <div className="people-list">
            {users.map((u) => (
              <Link key={u.id} href={`/users/${u.id}`}>
                <PetImage image={u.avatar} alt={u.displayName} />
                <span>{u.displayName}</span>
                <span>查看主页 →</span>
              </Link>
            ))}
          </div>
        </>
      )}
      {posts.length > 0 && (
        <>
          <h2 className="subheading">帖子</h2>
          <PostFeed posts={posts} />
        </>
      )}
      {term && !posts.length && !users.length && (
        <Empty title="没有找到相关内容">
          <p>试试宠友昵称，或帖子中的关键词。</p>
        </Empty>
      )}
    </section>
  );
}
