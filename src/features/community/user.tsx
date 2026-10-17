"use client";
import Link from "next/link";
import { useDemo } from "@/features/demo/provider";
import { Empty, PetCard, PetImage } from "@/components/ui";
import { FollowButton, PostFeed } from "./community";

export function UserProfile({ id }: { id: string }) {
  const { state } = useDemo();
  if (!state) return null;
  const user = state.users.find((u) => u.id === id);
  if (!user)
    return (
      <Empty title="这位用户不存在">
        <Link href="/search">返回搜索</Link>
      </Empty>
    );
  const pets = state.pets.filter((p) => p.ownerId === id && !p.archivedAt);
  const posts = state.posts.filter((p) => p.authorId === id);
  return (
    <>
      <Link href="/" className="back-link">
        ← 返回社区
      </Link>
      <section className="profile-card card">
        <PetImage image={user.avatar} alt={user.displayName} />
        <div>
          <h1>{user.displayName}</h1>
          <p>
            {pets.map((p) => p.name).join("、") || "毛孩子"}
            的主人
          </p>
          <p>
            {state.follows.filter((f) => f.followerId === id).length} 关注 ·{" "}
            {state.follows.filter((f) => f.followingId === id).length} 粉丝
          </p>
        </div>
        <FollowButton userId={id} />
        {id === state.activeUserId && (
          <Link className="button secondary" href="/me">
            我的主页
          </Link>
        )}
      </section>
      <h2 className="subheading">毛孩子档案</h2>
      <div className="pet-grid my-pets">
        {pets.map((p) => (
          <PetCard key={p.id} pet={p} own={p.ownerId === state.activeUserId} />
        ))}
      </div>
      <h2 className="subheading">日常分享 · {posts.length}</h2>
      {posts.length ? (
        <PostFeed posts={posts} />
      ) : (
        <Empty title="还没有发布日常" />
      )}
    </>
  );
}
