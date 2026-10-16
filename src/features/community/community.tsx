"use client";
import Link from "next/link";
import {
  ArrowUpRight,
  Heart,
  Leaf,
  MapPin,
  PawPrint,
  Sparkles,
  CalendarDays,
  ArrowRight,
  ImagePlus,
} from "lucide-react";
import { useState } from "react";
import { useDemo } from "@/features/demo/provider";
import { PetImage, Empty, formatTime } from "@/components/ui";
import { Post } from "@/domain/schemas";

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
  return (
    <article className="post-card card">
      <div className="post-head">
        <PetImage
          image={owner.avatar}
          alt={owner.displayName}
          className="avatar"
        />
        <div>
          <b>{owner.displayName}</b>
          <span className="mini-badge">模拟身份</span>
          <small>
            {pets.map((p) => p.name).join("、") || "毛孩子日常"}的主人 ·{" "}
            {formatTime(post.createdAt)}
          </small>
        </div>
        <span className="post-leaf">
          <Leaf size={18} />
        </span>
      </div>
      <p className="post-text">{post.text}</p>
      {post.images.length > 0 && (
        <Link
          href={detail ? "/discover" : `/posts/${post.id}`}
          className={`post-images count-${post.images.length}`}
          aria-label={detail ? "发现更多宠友" : "查看动态详情"}
        >
          {post.images.map((im, i) => (
            <PetImage
              key={i}
              image={im}
              alt={`${pets[0]?.name ?? "社区"}的日常照片 ${i + 1}`}
            />
          ))}
        </Link>
      )}
      <div className="post-topic">
        <PawPrint size={13} /> 毛孩子的日常 <span>· 虚构社区内容</span>
      </div>
      <div className="post-actions">
        <button
          className={liked ? "like liked" : "like"}
          disabled={!writable}
          aria-label={liked ? "取消点赞" : "点赞"}
          aria-pressed={liked}
          onClick={() => run({ type: "toggle-like", postId: post.id })}
        >
          <Heart size={19} fill={liked ? "currentColor" : "none"} />
          {post.likedByUserIds.length}
          <span>{liked ? "已喜欢" : "喜欢"}</span>
        </button>
        <span className="muted small">评论暂未开放</span>
        {!detail && (
          <Link href={`/posts/${post.id}`} className="text-link">
            看看日常 <ArrowUpRight size={15} />
          </Link>
        )}
      </div>
    </article>
  );
}
function HomeRail() {
  const { state } = useDemo();
  if (!state) return null;
  const activity = state.activities.find((a) => a.status === "scheduled");
  return (
    <aside className="home-rail">
      <div className="rail-heading">
        <h3>新朋友，打个招呼</h3>
        <Link href="/discover">
          <ArrowUpRight size={18} />
        </Link>
      </div>
      <div className="card friend-list">
        {state.pets
          .filter((p) => p.ownerId !== state.activeUserId && !p.archivedAt)
          .slice(0, 3)
          .map((p) => (
            <Link href={`/pets/${p.id}`} key={p.id}>
              <PetImage image={p.photo} alt={p.name} />
              <div>
                <b>
                  {p.name}
                  <span>虚构宠友</span>
                </b>
                <small>
                  {p.breed} · {p.district}
                </small>
              </div>
              <ArrowUpRight size={17} />
            </Link>
          ))}
      </div>
      <div className="rail-heading">
        <h3>下次一起去</h3>
        <span className="eyebrow">LET’S GO</span>
      </div>
      {activity && (
        <Link
          href={`/activities/${activity.id}`}
          className="rail-activity card"
        >
          <PetImage
            image={{ kind: "static", path: "/images/dog-5.jpg" }}
            alt="户外狗狗"
          />
          <div>
            <span className="pill">
              <CalendarDays size={12} />{" "}
              {formatTime(activity.startAt).split(" ")[0]}
            </span>
            <h3>{activity.title}</h3>
            <p>
              <MapPin size={13} /> {activity.place.district} · 演示活动
            </p>
            <span className="text-link">
              看看活动 <ArrowRight size={14} />
            </span>
          </div>
        </Link>
      )}
      <div className="kind-note">
        <span>温柔相遇小约定</span>
        <h3>
          先问主人，
          <br />
          再交朋友。
        </h3>
        <p>
          牵引、饮水、拾便袋，
          <br />
          带上这些，也带上一点耐心。
        </p>
        <PawPrint size={50} />
      </div>
      <p className="rail-disclaimer">
        所有人物、宠物与互动均为虚构。
        <br />
        这里的每一份数据，只属于这个浏览器。
      </p>
    </aside>
  );
}
export function Home() {
  const { state } = useDemo();
  const [tab, setTab] = useState("all");
  if (!state) return null;
  const posts =
    tab === "mine"
      ? state.posts.filter((p) => p.authorId === state.activeUserId)
      : state.posts;
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <div className="hero-tag">
            <span /> HELLO, FURRY FRIENDS
          </div>
          <h1>
            把日常，过成
            <br />
            <em>有毛的好时光。</em>
          </h1>
          <p>
            分享一点可爱，遇见同频的朋友。
            <br />
            下一段快乐，从这里发生。
          </p>
          <Link href="/discover" className="button">
            去认识新朋友 <ArrowUpRight size={17} />
          </Link>
          <div className="hero-proof">
            <span>
              <PawPrint size={15} />
              25 位虚构毛孩子
            </span>
            <i /> 每种性格，都值得被喜欢
          </div>
        </div>
        <div className="hero-visual">
          <img
            src="/images/dog-1.jpg"
            alt="草地上的金毛狗狗"
            fetchPriority="high"
          />
          <span className="hero-sticker">
            <Heart size={16} fill="currentColor" /> 很高兴遇见你呀
          </span>
          <span className="hero-caption">
            LIFE IS BETTER
            <br />
            WITH PAWS.
          </span>
          <span className="hero-spark">
            <Sparkles size={33} />
          </span>
        </div>
      </section>
      <div className="home-columns">
        <section>
          <div className="section-heading">
            <div>
              <span className="eyebrow">LITTLE MOMENTS, BIG LOVE</span>
              <h2>
                社区新鲜事 <span>每个小日常，都很可爱</span>
              </h2>
            </div>
          </div>
          <Link href="/posts/new" className="compose card">
            <PetImage
              image={
                state.users.find((u) => u.id === state.activeUserId)!.avatar
              }
              alt="当前模拟身份"
              className="avatar"
            />
            <span>今天和毛孩子，有什么新鲜事？</span>
            <ImagePlus size={20} />
            <span className="compose-button">分享日常</span>
          </Link>
          <div className="tabs">
            <button
              className={tab === "all" ? "selected" : ""}
              onClick={() => setTab("all")}
            >
              社区动态 <span>{state.posts.length}</span>
            </button>
            <button
              className={tab === "mine" ? "selected" : ""}
              onClick={() => setTab("mine")}
            >
              我的发布
            </button>
            <span className="tabs-right">
              <Leaf size={13} /> 记录真实的修改
            </span>
          </div>
          <div className="post-list">
            {posts.length ? (
              posts.map((p) => <PostCard key={p.id} post={p} />)
            ) : (
              <Empty title="还没有自己的日常">
                <Link href="/posts/new" className="text-link">
                  发布第一条动态 →
                </Link>
              </Empty>
            )}
          </div>
        </section>
        <HomeRail />
      </div>
    </>
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
