import type { DemoState, Post } from "./schemas";

export const postTitle = (post: Post) => post.title || post.text.split(/\n/)[0];

export function communityPosts(
  state: DemoState,
  following = false,
  query = "",
) {
  const term = query.trim().toLocaleLowerCase();
  const authors = new Set(
    state.follows
      .filter((f) => f.followerId === state.activeUserId)
      .map((f) => f.followingId),
  );
  return state.posts.filter(
    (p) =>
      (!following || authors.has(p.authorId)) &&
      (!term || `${p.title}\n${p.text}`.toLocaleLowerCase().includes(term)),
  );
}
