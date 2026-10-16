"use client";
import Link from "next/link";
import { Heart, Search, PawPrint } from "lucide-react";
import { useState } from "react";
import { useDemo } from "@/features/demo/provider";
import { PetImage, Empty, formatTime } from "@/components/ui";
import { Post } from "@/domain/schemas";
import { communityPosts, postTitle } from "@/domain/community";

export function FollowButton({ userId }: { userId: string }) {
  const { state, run, writable } = useDemo();
  if (!state || userId === state.activeUserId) return null;
  const followed = state.follows.some(
    (f) => f.followerId === state.activeUserId && f.followingId === userId,
  );
  return (
    <button
      className={`button small ${followed ? "secondary" : ""}`}
      disabled={!writable}
      aria-pressed={followed}
      onClick={() => run({ type: "toggle-follow", userId })}
    >
      {followed ? "已关注" : "关注"}
    </button>
  );
}

export function PostCard({
  post,
  detail = false,
}: {
  post: Post;
  detail?: boolean;
}) {
  const { state, run, writable } = useDemo();
  if (!state) return null;
  const owner = state.users.find((u) => u.id === post.authorId)!;
  const pets = state.pets.filter((p) => post.petIds.includes(p.id));
  const liked = post.likedByUserIds.includes(state.activeUserId);
  const like = (
    <button
      className={liked ? "like liked" : "like"}
      disabled={!writable}
      aria-label={liked ? "取消点赞" : "点赞"}
      aria-pressed={liked}
      onClick={() => run({ type: "toggle-like", postId: post.id })}
    >
      <Heart size={17} fill={liked ? "currentColor" : "none"} />
      {post.likedByUserIds.length}
    </button>
  );
  const author = (
    <Link href={`/users/${owner.id}`} className="note-author">
      <PetImage
        image={owner.avatar}
        alt={owner.displayName}
        className="avatar"
      />
      <span>{owner.displayName}</span>
    </Link>
  );
  if (detail)
    return (
      <article className="post-card card note-detail">
        <div className="row-between">
          {author}
          <FollowButton userId={owner.id} />
        </div>
        <div className="note-gallery">
          {post.images.map((im, i) => (
            <PetImage key={i} image={im} alt={`帖子照片 ${i + 1}`} />
          ))}
        </div>
        <h1>{postTitle(post)}</h1>
        <p className="note-body">{post.text}</p>
        <div className="tags">
          {pets.map((p) => (
            <Link key={p.id} href={`/pets/${p.id}`}>
              #{p.name} · {p.breed}
            </Link>
          ))}
        </div>
        <p className="form-hint">{formatTime(post.createdAt)} · 本地演示社区</p>
        <div className="post-actions">
          {like}
          <span className="muted">评论暂未开放</span>
        </div>
      </article>
    );
  return (
    <article className="post-card card note-card" data-post-id={post.id}>
      <Link
        href={`/posts/${post.id}`}
        className="note-main"
        aria-label={`查看动态详情：${postTitle(post)}`}
      >
        {post.images.length > 0 ? (
          <PetImage
            image={post.images[0]}
            alt={postTitle(post)}
            className="note-cover"
          />
        ) : (
          <div className="text-cover">
            <PawPrint size={24} />
            <p>{post.text.slice(0, 100)}</p>
            <span>毛孩子的文字日记</span>
          </div>
        )}
        <h2>{postTitle(post)}</h2>
        {pets.length > 0 && (
          <p className="note-tag">
            #{pets[0].name} · {pets[0].breed}
          </p>
        )}
      </Link>
      <div className="note-meta">
        {author}
        {like}
      </div>
    </article>
  );
}
export function PostFeed({ posts }: { posts: Post[] }) {
  return (
    <div className="masonry-feed">
      {[0, 1].map((column) => (
        <div className="masonry-column" key={column}>
          {posts
            .filter((_, index) => index % 2 === column)
            .map((p) => (
              <PostCard key={p.id} post={p} />
            ))}
        </div>
      ))}
    </div>
  );
}
export function Home() {
  const { state } = useDemo();
  const [tab, setTab] = useState("discover");
  if (!state) return null;
  const posts = communityPosts(state, tab === "following");
  return (
    <section className="community-home">
      <h1 className="sr-only">宠物社区</h1>
      <div className="feed-header">
        <Link href="/me" className="icon-button" aria-label="我的社区">
          <PawPrint size={24} />
        </Link>
        <div className="feed-tabs" role="group" aria-label="社区内容">
          <button
            aria-pressed={tab === "following"}
            onClick={() => setTab("following")}
          >
            关注
          </button>
          <button
            aria-pressed={tab === "discover"}
            onClick={() => setTab("discover")}
          >
            发现
          </button>
        </div>
        <Link href="/search" className="icon-button" aria-label="搜索">
          <Search size={23} />
        </Link>
      </div>
      <p className="feed-caption">
        {tab === "discover"
          ? "有毛的日常，一起分享"
          : "你关注的宠友，最近在做什么"}
        <span>{posts.length} 篇日常</span>
      </p>
      {posts.length ? (
        <PostFeed posts={posts} />
      ) : (
        <Empty title="还没有关注的日常">
          <p>在帖子详情或用户主页关注主人，他们的帖子就会出现在这里。</p>
          <button
            className="button secondary"
            onClick={() => setTab("discover")}
          >
            去发现宠友
          </button>
        </Empty>
      )}
    </section>
  );
}
export function PostDetail({ id }: { id: string }) {
  const { state } = useDemo();
  const p = state?.posts.find((p) => p.id === id);
  return p ? (
    <div className="narrow">
      <Link href="/" className="back-link">
        ← 返回社区
      </Link>
      <PostCard post={p} detail />
    </div>
  ) : (
    <Empty title="这条动态不存在">
      <Link href="/">返回社区</Link>
    </Empty>
  );
}
