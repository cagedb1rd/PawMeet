import { DemoState, stateSchema } from "@/domain/schemas";

export const demoPlaces = [
  {
    source: "demo",
    name: "白马湖公园 · 公共草坪（演示点）",
    district: "滨江区",
    location: { lng: 120.189, lat: 30.174, crs: "GCJ02" },
    petAccess: "unknown",
  },
  {
    source: "demo",
    name: "滨江沿江步道 · 公共入口（演示点）",
    district: "滨江区",
    location: { lng: 120.206, lat: 30.212, crs: "GCJ02" },
    petAccess: "unknown",
  },
  {
    source: "demo",
    name: "西兴公园 · 公共入口（演示点）",
    district: "滨江区",
    location: { lng: 120.224, lat: 30.194, crs: "GCJ02" },
    petAccess: "unknown",
  },
] as const;
export const photo = (index: number) => ({
  kind: "static" as const,
  path: `/images/dog-${(index % 6) + 1}.jpg`,
});
export function createSeed(now = new Date()): DemoState {
  const at = now.toISOString();
  const base = (id: string) => ({
    id,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  });
  const owners = [
    "林小满",
    "陈一一",
    "周可可",
    "许阿树",
    "沈知夏",
    "松子妈",
    "乐乐爸",
    "阿橙",
    "小禾",
    "沐沐",
    "山竹",
    "丸子",
    "小陆",
    "鹿鹿",
    "阿南",
    "小晴",
    "晓晓",
    "小宇",
    "安安",
    "清风",
    "小舟",
    "甜豆",
    "果果",
    "七七",
    "栗子",
  ];
  const names = [
    "年糕",
    "布丁",
    "可乐",
    "豆包",
    "麦麦",
    "松子",
    "乐乐",
    "橙子",
    "小米",
    "沐沐",
    "山竹",
    "丸子",
    "团团",
    "鹿鹿",
    "南瓜",
    "晴天",
    "小白",
    "宇宙",
    "安安",
    "奥利",
    "船长",
    "甜豆",
    "果冻",
    "七七",
    "栗子",
  ];
  const breeds = ["金毛", "柯基", "比熊", "柴犬", "边境牧羊犬", "拉布拉多"];
  const users = owners.map((displayName, i) => ({
    ...base(`user-${i + 1}`),
    displayName,
    avatar: photo(i),
    isSwitchable: i < 5,
  }));
  const pets = names.map((name, i) => ({
    ...base(`pet-${i + 1}`),
    ownerId: users[i].id,
    species: "dog" as const,
    name,
    breed: breeds[i % 6],
    ageMonths: 12 + i * 2,
    size: (i % 6 === 0 || i % 6 === 5
      ? "large"
      : i % 6 === 1 || i % 6 === 2
        ? "small"
        : "medium") as "large" | "small" | "medium",
    city: "杭州",
    district:
      i < 15 ? "滨江区" : i < 19 ? "萧山区" : i < 22 ? "上城区" : "西湖区",
    photo: photo(i),
    temperamentTags:
      i % 2
        ? ["慢热" as const, "亲人" as const]
        : ["温和" as const, "活泼" as const],
    activityTags:
      i % 2
        ? ["散步" as const, "晒太阳" as const]
        : ["散步" as const, "草地撒欢" as const],
    socialNotes: "虚构档案。初次见面请保持牵引，由主人确认互动方式。",
    demoLocation: {
      lng: 120.17 + i * 0.002,
      lat: 30.18 + (i % 5) * 0.003,
      crs: "GCJ02" as const,
    },
    isFictional: true as const,
    archivedAt: null,
  }));
  const copy = [
    "今天的快乐，是草地和好朋友给的。年糕的春夏秋冬，都想和大家一起慢慢走。🌿",
    "原来散步的意义，就是看它认真闻遍每一片叶子。今天也收集到好多小快乐！",
    "周末不赶路，和毛孩子在江边吹吹风。带上水和拾便袋，出发！",
    "新来的小朋友有点慢热，给它一点时间，友谊会慢慢发芽。",
    "天气正好，一起去草地上打个滚吧。你家毛孩子最喜欢什么户外活动？",
    "今日份晒太阳打卡。平凡的小日子，有你就很可爱。",
  ];
  const posts = Array.from({ length: 12 }, (_, i) => ({
    ...base(`post-${i + 1}`),
    authorId: users[i].id,
    petIds: [pets[i].id],
    text: copy[i % 6],
    images: [photo(i)],
    likedByUserIds: [users[(i + 2) % 25].id, users[(i + 3) % 25].id],
    createdAt: new Date(now.getTime() - i * 3600000).toISOString(),
  }));
  const activities = Array.from({ length: 6 }, (_, i) => ({
    ...base(`activity-${i + 1}`),
    organizerId: users[i + 1].id,
    organizerPetId: pets[i + 1].id,
    recommendedPetIds: [],
    title: [
      "周末草地撒欢计划",
      "落日江边慢慢走",
      "小体型狗狗见面会",
      "一起探索闻闻路线",
      "周日公园轻松局",
      "毛孩子的早安派对",
    ][i],
    description:
      "虚构演示活动，不是真实邀约。准备饮水、牵引绳和拾便袋；集合后先保持距离，由主人确认互动。",
    place: demoPlaces[i % 3],
    startAt: new Date(now.getTime() + (i + 2) * 86400000).toISOString(),
    endAt: new Date(now.getTime() + (i + 2) * 86400000 + 7200000).toISOString(),
    capacity: 6,
    status: "scheduled" as const,
  }));
  const activitySignups = activities.map((a, i) => ({
    ...base(`signup-${i + 1}`),
    activityId: a.id,
    userId: a.organizerId,
    petId: a.organizerPetId,
    status: "joined" as const,
  }));
  const helpRequests = Array.from({ length: 8 }, (_, i) => ({
    ...base(`help-${i + 1}`),
    requesterId: users[i].id,
    petId: pets[i].id,
    type: i % 2 ? ("feed" as const) : ("walk" as const),
    title: i % 2 ? "想找一位邻居帮忙喂食" : "有朋友可以陪它散散步吗？",
    details: "虚构需求预览，互助申请与交接流程将在 Phase 2 开放。",
    startAt: new Date(now.getTime() + (i + 3) * 86400000).toISOString(),
    endAt: new Date(now.getTime() + (i + 3) * 86400000 + 3600000).toISOString(),
    place: demoPlaces[i % 3],
    status: "open" as const,
  }));
  return stateSchema.parse({
    schemaVersion: 1,
    seedVersion: 1,
    revision: 0,
    seededAt: at,
    activeUserId: users[0].id,
    users,
    pets,
    posts,
    activities,
    activitySignups,
    helpRequests,
    socialCards: [],
    helpApplications: [],
    helpEvents: [],
    careChecklists: [],
    settings: { timezone: "Asia/Shanghai" },
  });
}
