import { DemoState, Pet } from "./schemas";

export const behaviors = [
  "追逐",
  "贴近嗅闻",
  "身体接触",
  "分享玩具",
  "并排散步",
  "安静陪伴",
] as const;
export function cardFor(s: DemoState, p: Pet) {
  return s.socialCards.find(
    (c) => c.petId === p.id && c.petRevision === p.revision,
  );
}
export function comparePets(s: DemoState, a: Pet, b: Pet) {
  const ca = cardFor(s, a),
    cb = cardFor(s, b);
  const conflicts: string[] = [];
  const likes = (p: Pet, c: typeof ca) => [
    ...(c?.likes ?? []),
    ...(p.temperamentTags.includes("喜欢追逐") ? ["追逐"] : []),
  ];
  const dislikes = (p: Pet, c: typeof ca) => [
    ...(c?.dislikes ?? []),
    ...(p.temperamentTags.includes("怕追逐") ? ["追逐"] : []),
  ];
  for (const [p, q, cp, cq] of [
    [a, b, ca, cb],
    [b, a, cb, ca],
  ] as const)
    for (const behavior of behaviors)
      if (likes(p, cp).includes(behavior) && dislikes(q, cq).includes(behavior))
        conflicts.push(
          `${p.name}喜欢${behavior}，${q.name}不喜欢${behavior}，初次见面请避开这一互动。`,
        );
  return {
    conflicts,
    shared: behaviors.filter(
      (t) => likes(a, ca).includes(t) && likes(b, cb).includes(t),
    ),
    incomplete: !ca || !cb,
    advice: [
      "选择安静的公共场地，双方主人在场并保持牵引。",
      "先留出距离，短时间并排散步，观察双方反应；出现不适立即拉开距离或结束。",
      "互动方式、习惯和未知信息请在见面前由主人逐项确认。",
    ],
  };
}
