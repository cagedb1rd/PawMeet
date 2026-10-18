import type { DemoState, Post } from "./schemas";

export const postTitle = (post: Post) => post.title || post.text.split(/\n/)[0];

/**
 * Splits the tag field ("#柯基 #海边, 周末") into tags without "#". Duplicates are removed;
 * length / character rules are left to postInputSchema so errors stay visible.
 */
export function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,，、#＃]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
}
export const formatTags = (tags: readonly string[]) =>
  tags.map((t) => `#${t}`).join(" ");

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
      (!term ||
        `${p.title}\n${p.text}\n${formatTags(p.tags)}`
          .toLocaleLowerCase()
          .includes(term)),
  );
}
