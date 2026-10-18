# PawMeet 技术架构

状态：2026-10-17。Phase 1–3 本地业务与地图保留；Phase 4.5 精简为智能约伴、档案填写、互助填表三个 AI 场景，复用原 Qwen 服务和原生工具调用循环；新版导航及人工业务保持。真实模型仍存在额度 / 超时和输出错误，不能标为阶段完成；证据见 [AI_EVAL](AI_EVAL.md) 与 [PROGRESS](PROGRESS.md)。原 Phase 5 已由 [展示改进计划](PLAN.md#7-展示改进计划) 取代。

## 1. 选型与边界

| 层 | 决策 | 理由 |
| --- | --- | --- |
| 应用 | Next.js App Router + React + TypeScript strict | 单应用承担页面与受保护服务端接口，无独立后端工程 |
| UI | Tailwind CSS、按需 shadcn/ui / Radix、Lucide | 快速形成可访问的移动端抽屉与桌面布局，不整套引入重型组件库 |
| 状态 | React Context 发布已持久化快照，纯业务命令 + Repository | 写入成功才更新状态；不在 reducer 中执行存储副作用，不先引入全局状态库 |
| 校验 | Zod 4，表单、持久化、API 契约共享定义 | 类型来源统一；AI 草稿 Schema 与正式业务 Schema 分离 |
| 数据 | localStorage JSON + 图片 IndexedDB + 项目静态资源 | 不使用云数据库；每浏览器独立 |
| 地图 | 高德 JS API 2.0，官方 script 方式按需加载 | 单例加载与服务适配器隔离，安全码仅服务端 |
| AI | 服务端原生 fetch 调用 OpenAI 兼容 API：Qwen（百炼）为默认，Gemini（Google 官方兼容端点）为跨厂商对照 | 少依赖；按任务设置 Prompt、Schema、token 上限；按型号配置厂商参数 |
| 测试 | Vitest、Testing Library（必要组件）、Playwright | 规则 / 存储 / 接口 / 关键用户路径分层验证 |
| 工具 | npm + package-lock、ESLint CLI、Git | 不混用包管理器；build 不替代 lint |

当前运行环境 Node 24.15.0 / npm 11.12.1；Next 16.4.2、React 19.3.1、Zod 4.6.7、Tailwind 4.3.3 已安装并锁定，其他精确版本见 [package.json](../package.json) 和 lockfile。已通过生产构建与 Chromium 流程测试，不代表其他设备和国内网络均通过。没有使用 canary 或外部字体 CDN。

```mermaid
flowchart LR
  UI[响应式页面 / 确认表单] --> CMD[业务命令与 Zod 校验]
  CMD --> STORE[浏览器 Repository]
  STORE --> LS[localStorage 结构化状态]
  STORE --> IDB[IndexedDB 图片]
  UI --> PARSE[同源 AI Route Handler]
  PARSE --> GUARD[校验 / 限额 / 固定 Prompt]
  GUARD --> Qwen[真实 Qwen API]
  Qwen --> DRAFT[Zod 校验后的草稿]
  DRAFT --> UI
  STORE --> QUERY[规则查询 / 距离 / 排序]
  QUERY --> UI
  UI --> MAP[客户端地图适配器]
  MAP --> PROXY[受限高德服务代理]
  PROXY --> AMAP[高德服务]
```

搜索条件使用 URL 查询参数与 Next History 集成，页内更新使用 replaceState，不为每次输入创建历史项；顶部搜索读取同一参数，浏览器返回恢复条件。活动展示状态由 [presentation](../src/features/activities/presentation.ts) 按原业务时间与名额派生，不替代命令校验。

SSR 只输出公共页面壳与稳定骨架。浏览器 `DemoProvider` 挂载后读取 / 校验状态再显示个人数据，避免 hydration mismatch；服务端组件、API Route 无法读取 localStorage。业务新增 / 修改不发送服务端持久化接口。状态中的身份仅用于演示逻辑，不作为服务端鉴权或额度依据。

## 2. 实现目录与扩展边界

当前核心路径：

```text
src/app/                         # 首页 / 附近 / 发布 / 活动 / 我的，搜索、用户及实体详情
src/components/{shell,ui}.tsx     # 响应式壳、Dialog、图片及公共 UI
src/features/demo/provider.tsx   # 挂载读取、单标签锁、快照发布、恢复 / 重置
src/features/{pets,community,activities,discover,help,cards,me,forms}/
src/domain/community.ts          # 关注流、标题降级与标题 / 正文查询
src/app/redesign.css              # 当前社区布局及共享响应式覆盖，基础表单 / 地图沿用 globals.css
src/domain/{schemas,commands,phase2,social}.ts # Zod、状态机、角色与确定性偏好规则
src/domain/legacy-schema.ts      # 冻结的 Phase 1 v1 校验器，仅用于迁移
src/data/seed.ts                 # 固定种子 ID、相对时间与公共演示地点
src/lib/storage/                # repository 与 IndexedDB 图片适配器
src/lib/{ai,maps}/contracts.ts   # 共享输入输出与工具结果 Schema
src/domain/{geo,discover}.ts     # GCJ02 Haversine 与唯一宠友查询
src/features/maps/              # MapCanvas、PlaceExplorer / PlacePicker、地点详情
src/lib/maps/{client,proxy,navigation}.ts # SDK 服务、代理校验、导航 URI
src/app/api/maps/config/route.ts # 只返回公开 JS Key，配置缺失 503
src/app/%5FAMapService/[...path]/route.ts # 对外 URL /_AMapService
src/server/maps/{http,quota}.ts  # 固定 HTTPS 上游、持久限额；server-only
public/images/                  # 本地照片、占位图、来源许可
tests/{unit,e2e,live}/           # 规则 / 存储 / SDK mock 与显式真实地图检查
```

Phase 4 实现入口：

```text
src/app/api/ai/[task]/route.ts     # 固定任务白名单，无通用聊天透传
src/domain/matching.ts            # 可解释偏好匹配分与比较依据
src/lib/ai/                       # 客户端、Schema、语义校验、只读工具执行器
src/server/ai/                    # server-only Qwen client、prompts、validators
tests/unit/ai*.test.ts            # Qwen mock、工具协议、限额与规则
evals/{cases,lib,runner,reports}/  # cases.v3 41条多模型runner+分模型额度；core.v2仅mock回归；live/simulated分开报告
```

当前业务组件通过 Provider 的 `run` 调用纯命令和 Repository；`PetImage` 管理上传图 object URL 的创建 / 回收，原生 dialog 提供焦点与 Esc 关闭，表单包含未保存提醒；[feedback](../src/features/forms/feedback.tsx) 将 Schema 错误映射为中文、关联输入并定位，清除错误时还原 ARIA 属性。AI 填入标记只属于 DOM 展示状态，不进入持久化。名片、两宠比较和 PNG 导出位于 `features/cards`；地点选择器位于 `features/maps`，嵌入表单并只更新内存草稿；筛选使用可折叠区域。AI 草稿复核位于 features/ai/draft.tsx，智能约伴位于 /activities，/assistant 重定向到活动页。地图适配器不含业务排序逻辑；AI 组件不能直接写 Repository。

## 3. 数据契约

通用：ID 为带前缀稳定种子 ID 或 `crypto.randomUUID()`；时间以 UTC ISO 字符串保存、按 Asia/Shanghai 展示；月龄为非负整数而非浮点岁数。每个实体有 id、createdAt、updatedAt、revision；种子角色均虚构。Zod 使用 strict 对象、有限数组与文本长度，拒绝额外字段。名片和清单只接受 `manual`，地点接受 `demo/amap/manual`；AI 草稿仅在内存，用户编辑并确认后保存为主人复核内容；现有 source=manual 代表最终人工确认，暂不单独持久化模型溯源。

| 实体 | 核心字段与约束 |
| --- | --- |
| DemoUser | displayName、avatar ImageRef、isSwitchable；共 25 条，5 条可切换 |
| Pet | ownerId、species=`dog`、name(1–20)、breed(1–30，可“未知”)、ageMonths(null 或 0–360)、size=`small/medium/large/unknown`、city、district、photo ImageRef、temperamentTags、activityTags、socialNotes(≤500)、demoLocation、isFictional=true |
| SocialCard | petId、petRevision、traits / likes / dislikes / cautions（各 ≤6 项、单项 ≤60 字）、meetingAdvice(≤300 字)、source=`manual`、confirmedAt、confirmedBy；空数组表示未知，不能当作没有风险 |
| Post | authorId、petIds(≤3)、title(0–60，旧数据缺省空串)、text(1–1000)、tags(0–5 个话题标签，不含 #，每个 ≤12 字且只含中文 / 字母 / 数字 / 下划线、不重复，旧数据缺省空数组)、images(≤3)、likedByUserIds（去重 ID） |
| Follow（信封内关系） | followerId / followingId，只允许可切换身份关注存在的其他主人；有向关系去重，不允许自己关注自己 |
| Activity | organizerId、organizerPetId、recommendedPetIds(≤5，仅推荐)、title(1–40)、description(≤500)、place PlaceRef、startAt、endAt、capacity(2–12)、status=`scheduled/cancelled` |
| ActivitySignup | activityId、userId、petId、status=`joined/cancelled`；每活动每身份最多一个 joined；组织者自动 joined |
| HelpRequest | requesterId、petId、type=`walk/feed`、title、details(≤1000)、startAt、endAt、place、status=`open/assigned/helper_done/completed/cancelled`、helperId?、acceptedApplicationId?、contentRevision（仅核心内容修改递增） |
| HelpApplication | helpId、applicantId、message(≤200)、status=`pending/accepted/rejected/withdrawn`；同人同需求最多一个有效申请 |
| HelpEvent | helpId、actorId、action、fromState、toState、createdAt；状态变化与记录一次写入 |
| CareChecklist | helpId、petRevision、requestRevision、items（≤12 个 title/detail/needsConfirmation）、source=`manual`、confirmedBy、confirmedAt；requestRevision 引用需求 contentRevision，档案或需求内容变更要求重新确认 |
| ReferenceLocation（页面状态） | lng、lat、crs=`GCJ02`，另保存可见来源标签；不进入持久化信封，与宠物展示位置独立 |
| PlaceRef | source=`amap/manual/demo` 判别联合；name(≤60)、district(≤30)、address?(≤200)、location GCJ02（经度±180、纬度±90）；仅 manual 可为 null，仅 amap 可有 poiId；petAccess 固定 unknown |
| ImageRef | 判别联合：`{kind:static,path}` 或 `{kind:upload,imageId}`；不存 base64 或任意远程 URL |

正式 Pet 至少名称、照片（可选项目占位图）、品种 / 未知、体型 / 未知、城市区域和公共演示位置有效。年龄未知可 null，不阻碍保存。性格 / 活动数组各 ≤8 个，受控标签加说明字段；常用标签词典在 Phase 1 定稿并供 Prompt 引用。活动 / 互助发布须有确定的未来起止时间、地点、本人宠物；`endAt > startAt`，时间边界按同一 clock 计算，不能把未知值自动补成事实。

当前存储 key 保留 `pawmeet:state:v1`，信封 `schemaVersion=2`：schemaVersion、seedVersion、revision、seededAt、activeUserId、users、pets、socialCards、posts、activities、activitySignups、helpRequests、helpApplications、helpEvents、careChecklists、follows、settings。草稿与 UI 状态默认内存保存；用户确认后的业务对象才进入信封。可保存明确“手工草稿”，但不得当作发布记录。

Phase 3 对 v2 的 PlaceRef 作兼容扩展，不重写已有 demo 地点或档案坐标。新浏览器 / 用户明确重置才获得调整后的 25 个演示区域点；没有自动迁移用户位置。旧 v1 仍用冻结 Schema 校验后纯迁移到 v2；旧版应用不承诺理解新增来源，因此不要回退旧应用继续写新数据。

Phase 4.6 兼容扩展 `title` 和 `follows`：Zod 对旧 v2 缺失字段补空标题 / 空关系，保留 key 和 schemaVersion=2；读取不改写磁盘，下一次成功命令才落盘。v1 仍先通过冻结旧 Schema 再迁移。损坏字段、未知属性及无效关注引用仍拒绝读取，不靠默认值掩盖损坏。关注由 `toggle-follow` 命令和同一 Repository 提交，失败不更新视图；不新增独立存储系统。标题为空只在展示时取正文首行，不重写原正文。

页面与组件边界见 [UI_REDESIGN](UI_REDESIGN.md)：`PostFeed` 将帖子交替分入两列，各列自然堆叠；`PostCard` 复用列表 / 详情点赞，`FollowButton` 在用户主页和详情复用，`NearbyTabs` 保留原业务 URL。搜索只读当前快照，不调用 AI；新关注关系不会作为额外模型上下文发送。活动距离用 `DEFAULT_REFERENCE`（杭州滨江公共演示点）和现有 GCJ02 Haversine，不冒充实时位置；无坐标显示未知。智能约伴在活动页复用该卡片风格，不改变首页与导航。

引用完整性：宠物必须引用存在主人；报名引用存在活动和该身份拥有的宠物，组织者必须占一个名额，报名和点赞去重。档案删除使用 `archivedAt` 归档，不物理删除，历史动态引用保留；有未结束活动、未来开放互助或 assigned / helper_done 互助引用时阻止删除。归档宠物不出现在发现和选择器，不能再编辑 / 新报名。帖子无删除入口。名片仅主人可确认且 petRevision 必须当前；清单仅求助人可编辑，引用当前宠物版本与需求 contentRevision。实体引用、有效申请唯一性、已选帮助者 / acceptedApplicationId 一致性由 Schema 校验；具体操作的角色与状态在命令层校验。

### Phase 2 命令、查询与分享

- [phase2.ts](../src/domain/phase2.ts) 统一处理 `save-card`、`save-help`、`apply-help`、`withdraw-help`、`assign-help`、`helper-done`、`complete-help`、`cancel-help`、`save-checklist`；Provider 仍只发布持久化成功的新快照。
- 互助状态与权限遵循 [PRD](PRD.md#互助状态机与权限)。选择帮助者前必须有主人确认的当前版本清单；清单可显式保留细节待确认，不补全未知事实。帮助者标记完成时也复核清单版本。选择与双方完成重试不重复产生事件；重复申请明确拒绝。
- 申请 / 撤回 / 清单保存只修改独立实体和事件；状态迁移更新任务 revision。需求编辑另递增 contentRevision，因此选帮助者等状态变化不会误使交接内容失效。仅 open、未来且无有效申请可编辑核心字段；清单只允许 open / assigned 编辑。所有写入受整个信封上限和 2MiB 预算约束。
- [social.ts](../src/domain/social.ts) 仅对有效名片 likes / dislikes 的六个完整词条，以及档案“喜欢追逐 / 怕追逐”做双向冲突判断。自由文字保留展示，不做否定句、同义词或隐含风险推断。未识别冲突不等于适合互动；不输出行为诊断、安全结论或评分。名片引用失效时不参与规则并禁止导出。
- [export.ts](../src/features/cards/export.ts) 用本地 canvas 排版生成 PNG，按内容行数决定高度；照片来源仅本地静态图或 IndexedDB。支持 `canShare` 时分享 PNG 文件，否则下载；不生成跨设备本地 ID 分享链接。
- 档案 / 宠友卡进入名片比较；档案或比较页进入 `/activities/new?recommendedPetId=…`，保存推荐宠物引用，公共地点为待主人确认的默认演示建议，绝不表示邀请已发送 / 对方已同意。
- [AI contracts](../src/lib/ai/contracts.ts) 定义任务输入输出、工具调用与有界结果Schema；正式保存仍经过共享 Schema 和命令。统一任务和原生 Tool Calling 已接入；真实结果与 mock 证据分列 AI_EVAL。

## 4. 浏览器存储与恢复

1. 首次挂载：读取信封 → 版本检查与 Zod / 引用校验 → 无数据才初始化种子。v1 先由冻结的旧 Schema 严格校验，纯迁移到 v2，给互助补 null 帮助者引用及 contentRevision=1；只读加载不写原文，下次持有写锁的命令才原子保存 v2。旧版种子预览文案仅在完整匹配时更新为演示说明，用户内容保持。未知版本 / 旧数据损坏不覆盖。
2. 命令执行：从最新 revision 校验身份 / 状态 → 生成整个新快照 → 序列化与大小预检 → 单 key `setItem` 成功后更新内存并显示成功。QuotaExceeded / SecurityError 则保留原状态和表单，提示清理图片或重试。
3. 结构化数据保守预算 2MiB（按 UTF-16 估算，不承诺浏览器统一配额）；帖子上限 100、活动 / 互助各 100，达到上限提示重置 / 清理，不静默删除历史。读取损坏时保留原始数据，提供导出原文 / 确认重置，不自动重建覆盖。
4. 上传仅 JPEG / PNG / WebP，单原图 ≤8MiB，解码检查且拒绝超过 5000 万像素；最长边 ≤1280，Canvas 输出 WebP（不支持时浏览器可能返回 PNG），通过质量梯度控制为 ≤250KiB，超出则拒绝。每帖 ≤3 张、全局 ≤30 张且 ≤10MiB；全局检查和插入在同一个 IndexedDB readwrite 事务完成。先写 Blob 再提交 ImageRef；图片失败不产生引用。业务提交失败保留表单与已上传照片以便重试，取消 / 离开表单时清理本次临时图；异常退出的孤儿可在“我的”清理。缺图显示占位，宠物主人可编辑替换。图片不入 localStorage、不送模型；刷新重新生成并回收 object URL。
5. reset：确认 → 准备新种子 → 写入新信封 → 清理旧上传图。清理失败报告可重试，但不得继续引用已删图。种子静态图无需删除。
6. 同一源只支持一个可写标签页，Web Locks 持有写锁；第二标签页显示提示并只读。无 Web Locks 或获锁失败时同样关闭写入，不使用不能提供原子互斥的心跳抢锁。关闭原编辑页后刷新可接管。Repository 每次提交复读并比较完整快照 / revision，拒绝被外部更改的旧状态。storage 事件发现外部变更后禁用当前页写入并提示刷新，不做实时同步。浏览器必须在可信上下文使用相关能力；不能保证恶意直接改 localStorage 不破坏演示。

## 5. 规则查询与匹配

当前 [discoverQuery](../src/domain/discover.ts) 在客户端从当前快照执行：排除自己的 / 归档宠物 → 按参考位置计算距离 → 硬筛选 → 距离升序、同距按 ID 稳定排序。所有距离均为 **GCJ-02 坐标上的 Haversine 近似球面直线距离**，单位内部米，展示“大致直线距离”，不是路线距离或 GPS 测量。

- distanceKm 白名单 1/3/5/10，边界包含 `distanceM <= radiusM`，在未四舍五入值上比较；距离排序同值按 ID 稳定排序。默认 5km，参考点为滨江公共演示中心。
- 同筛选字段多选 OR，字段间 AND；当前支持品种、体型、受控性格和活动偏好，以及名称 / 品种 / 区域文字搜索。缺失标签不满足正向条件；切参考点重算全部结果。范围、数量和枚举由共享 `discoverFilterSchema` 校验，AI 只能提交查询条件，不生成宠友实体或距离。

[matching.ts](../src/domain/matching.ts) 已实现推荐扩展：
- 匹配为可解释偏好分（非安全概率）：活动标签 Jaccard ×45、已知相同性格且无已识别冲突项 ×30、体型相同项 ×15、`max(0,1-distanceM/10000)` ×10；未知项为 0 并提示信息不足，不归一化冒充完整信息。性格相容项复用明确相同标签与comparePets冲突规则，例如一方“怕追逐”而另一方“喜欢追逐”标注意事项，不推断攻击风险。
- 按匹配排序为分降序→距离升序→ID。显示对应规则贡献与已知差异，不将“同品种”默认计为合适。数字称“偏好匹配分”，不能叫安全分。
- 适配分析直接运行 comparePets，展示已识别冲突、共同偏好、缺失信息和初见建议，无独立模型调用。自由社交文字不做专业行为判断。

## 6. Qwen 调用与确认机制

### 统一服务与任务

[Route](../src/app/api/ai/[task]/route.ts) → [Service](../src/server/ai/service.ts) → [Client](../src/server/ai/client.ts)（[SSE 解析](../src/server/ai/sse.ts)、[模型白名单](../src/server/ai/models.ts)）。密钥、Prompt、模型配置与额度模块使用 server-only。模型只来自服务端白名单（见 [AGENTS](../AGENTS.md#ai-与模型)）：文本组由 AI_MODEL 选择（默认 qwen3.8-flash），视觉组由 AI_VISION_MODEL 选择（默认 qwen3.8-omni-flash）；名称须精确匹配所在组，否则返回 AI_MODEL_NOT_APPROVED，无自动回退。callModel 的 `model` 覆盖参数只供服务端 / 评测调用，同样受白名单约束；Route 不读取浏览器传入的模型字段（多余字段按 strict Schema 拒绝）。白名单 Qwen 5 个型号名经百炼模型列表、gemini-3.5-flash-lite / gemini-3.8-flash 经 Gemini 模型列表核实存在（见 [AI_EVAL](AI_EVAL.md#模型名核实2026-10-18) 与第 6b 步）。每个型号的 profile 指定 provider：dashscope 用 DASHSCOPE_API_KEY 与下述百炼端点；gemini 用 GEMINI_API_KEY 与固定的 `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`（不可配置）。取舍见 [DECISIONS D024](DECISIONS.md)。callModel 另有评测专用 `reserve` 钩子，以独立评测账本替代产品额度账本，Route 从不传入。旧 GLM_* 配置不再读取。Base URL 仅允许百炼官方 HTTPS 兼容端点：dashscope.aliyuncs.com、dashscope-intl.aliyuncs.com 或受限地域工作空间域名，路径固定 /compatible-mode/v1；拒绝凭据、端口、查询和客户端透传。

POST /api/ai/{task} 接受 {text, context}，当前公开结构化任务仅 pet-profile、help-intent、companion-intent；assistant 承载原生 Tool Calling；pet-photo 只接受 {image}（见下文“拍照建档”）；post-meta 只接受 {text, image?}、post-safety 只接受 {title, text, tags}（见下文“社区 AI”）。social-card、social-analysis、care-checklist、post-copy 与独立 match-intent 路由返回 AI_TASK_RETIRED，不消耗模型额度。旧契约 / 忠实性校验仍用于历史评测及内部匹配工具，冗余 Prompt 与界面已删除。主人手工编辑名片，照看清单由 [checklistTemplate](../src/lib/ai/templates.ts) 读取已有习惯 / 本次需求并补通用待确认项。

| 场景 | 最少上下文与结果 |
| --- | --- |
| pet-profile | 描述文本；基本信息可空，性格 / 活动标签附原文证据，填入后由主人编辑并确认保存 |
| help-intent | 描述 + 最多3只本人宠物摘要；类型、宠物、起止、时长、原始时间与公共地点线索；缺失信息及地点复核沿用原表单校验 |
| companion-intent | 描述 + 选中本人宠物摘要；match 包含 / 排斥条件、日期时间提议、活动类型、地点关键词、软偏好、其他硬要求、澄清；不返回实体 |
| pet-photo | 仅一张浏览器重新编码的 JPEG 缩略图（≤512px、无 EXIF）；输出是否为狗、多只狗、品种、体型、毛色、可见特征及各自置信度，经程序审核后返回草稿 |
| post-meta | 帖子正文，可选一张同规格缩略图；有图走视觉组模型，否则文本组；输出标题 / 标签 / 提示，经程序审核后返回草稿 |
| post-safety | 本帖标题、正文、标签（不含图片与其他数据），文本组模型；输出通过 / 建议修改及问题类别、原文片段、理由 |

成功 {ok:true,requestId,data,meta:{provider,model,promptVersion,schemaVersion,latencyMs,usage}}；失败 {ok:false,requestId,error:{code,message,retryable}}。400 输入 / 协议 / 模型能力不符、413 超量、403 来源、429 本地额度、499 客户端取消、503 配置 / 账本、502 上游 / 非法输出 / 流中断、504 超时。失败不返回上游原始正文或思考过程。

浏览器请求带 `Accept: application/x-ndjson` 时，Route 在模型开始返回（或进入自动重试）后改为 NDJSON：若干 `{type:"progress",stage:"waiting"|"receiving"|"retrying",attempt,chars}`，最后一行 `{type:"result",body:<成功信封>}` 或 `{type:"error",status,body:<失败信封>}`。在此之前发生的失败（来源、输入、额度、配置、上游 HTTP 错误）仍是普通 JSON 和真实 HTTP 状态。进度只含阶段与已接收字符数，不推送模型原文；结果仍在服务端整体解析并通过 Zod / 业务校验后才下发。[浏览器客户端](../src/lib/ai/client.ts) 兼容两种响应，界面在等待时显示已等待秒数，接收中显示字符数，重试时提示。

请求流上限48KB（pet-photo、post-meta 为170KB），描述1500字、摘要至多3宠；上游请求文本30000字节（图片不计 base64 长度，按下述图片 Token 规则估算）。Qwen：max_tokens=1400、temperature=0.1，文本模型发送 enable_thinking=false。Gemini：不发送 temperature 与 enable_thinking，发送 reasoning_effort（3.5-flash-lite 为 minimal、3.8-flash 为 low），max_tokens=4096（含思考 Token）；tool_calls 上的 `extra_content.google.thought_signature` 原样保存在签名上下文并在续传时回传，流式 tool_calls 缺 index 时按 id 归并。回答修复指令以 user 角色追加。

- 流式：默认 `stream:true` 并带 `stream_options.include_usage`，AI_STREAM=false 时走原非流式路径；只支持流式的模型（qwen3.5-omni-plus，见下文图片一条）强制流式。SSE 解析拼接 content 增量、按 index 拼接 tool_calls 片段（名称取首片段，arguments 连接），保留末尾 usage；原始流 ≤512000 字节、单行 ≤64000、文本 ≤16000 字符。未见 finish_reason 即断流为 AI_UPSTREAM_STREAM_INTERRUPTED，`length` 截断为 AI_UPSTREAM_INCOMPLETE，流内 error / 非法 JSON 显式失败。若上游忽略 stream 返回 JSON 信封，按非流式解析。
- 输出：结构化任务使用共享 Zod JSON Schema strict 并校验事实；原生 tools 使用 JSON 模式、tool_choice=auto 和 parallel_tool_calls=true，接收提供方真正的 assistant.tool_calls，不将 content 中的 JSON 当调用。流式与非流式都整体拼接后再走同一校验，不消费部分结果。格式错误最多一次无工具严格总结修复，计入4轮。
- 超时：AI_FIRST_BYTE_TIMEOUT_MS（默认15000，流式到首个数据块、非流式到响应头）与 AI_TOTAL_TIMEOUT_MS（默认40000，单次尝试）；浏览器120秒总超时并可取消，取消经 request.signal 中止上游。
- 重试：每次调用最多自动重试1次，退避500ms（短 Retry-After 最多3秒），每次尝试都重新预留额度、不退款。抽取类任务（generateTask）为 idempotent：429 / 500 / 502 / 503 / 504、受控连接错误、首字节或总超时、流中断都可重试。工具续传（assistantStep，含总结修复）为 pre-response：只在未消费任何响应体时重试（HTTP 429 / 5xx、连接错误、首字节超时）；工具只在浏览器收到签名步骤后执行，失败的尝试不生成续传凭据，因此不会重复执行业务工具。401 / 403 / 400、非法内容、截断、额度拒绝不重试。
- 图片：消息内容可为 `{type:"text"}` / `{type:"image_url",image_url:{url}}` 数组；[imagePart](../src/server/ai/client.ts) 只接受 JPEG / PNG / WebP base64 data URL 且 ≤400000 字符，单次最多4张；文本模型收到图片、视觉模型收到 tools 均返回 AI_MODEL_CAPABILITY。视觉组 4 个型号的调用要求（2026-10-19 按官方文档核实，来源见第 9 节）：
  - qwen3.8-omni-flash：支持非流式（随 AI_STREAM），默认开启思考（reasoning_effort 默认 xhigh），发送 `reasoning_effort:"none"` 关闭；只支持 JSON Mode（`json_object`，提示词须含 “JSON”），不支持 JSON Schema；发送 `modalities:["text"]`。
  - qwen3.5-omni-plus：只支持流式（强制 `stream:true`），无思考模式；JSON Mode，同上。百炼说明多模态输入请求 json_schema 会自动降级为 json_object，因此 Qwen 视觉统一发 json_object，结构由服务端 Zod 校验。Base64 Data URI ≤20MB，宽高 >10px。
  - gemini-3.5-flash-lite / gemini-3.8-flash：同一 Gemini OpenAI 兼容端点，图片用 `image_url` 的 `data:image/jpeg;base64,…`，内嵌请求总大小 ≤20MB；支持结构化输出，发送 strict `json_schema`；思考不可关闭，沿用 minimal / low，`max_tokens` 2048（含思考）。
  - 图片 Token（只用于预留，实际以 usage 结算）：Qwen 3.x 每 32×32 像素 1 Token +2（omni 页未单列，按旧版 28×28 与向上取整作上界，≤512px 最多约 363）；Gemini 3 默认 media_resolution 每张图上限 1120。尺寸未知时取厂商默认上限（Qwen 2562）。

[Prompt](../src/server/ai/prompts.ts) 版本 pawmeet-6.3，validation-11。档案 / 互助保留摘录、否定、年龄、日期、本人ID和剂量禁区等防线。约伴可接受粗略日期与时段：程序 [availability](../src/lib/ai/availability.ts) 按北京时间生成并展示只读查询边界，上午6–12点、下午12–18点、晚上18–24点；OR时段保留间隔，排除日期 / 时段从候选范围扣除。缺少日期才询问日期，不要求分钟；不把查询边界写入活动计划。普通软偏好改写不再导致整体事实校验失败：保留有依据的原话。性格 / 活动受控标签由程序维护的 [同义词表](../src/lib/ai/synonyms.ts) 映射（如随和 / 好相处 → 温和，遛弯 / 溜达 → 散步，好动 → 活泼），模型只需逐字保留原话；只扫描模型放入 preferences 和非硬性 unmappedTerms 的片段（跳过描述本人宠物的子句），否定前缀（不要太活泼）不算正向，映射结果只作软排序并在 warnings 列出“原话 → 标签”供核实，明确排斥同标签时排斥优先。同义词不会产生排斥、体型、品种或距离条件；含“必须 / 不要”等硬性措辞的未映射词仍走澄清，无法映射的软词仅提示不阻断搜索。无依据的硬条件、准入 / 安全保证仍拒绝，明确距离上限由程序核对，不支持或冲突先澄清。所有业务写入继续走正式 Schema、角色 / 状态和 Repository，身份 / 数据 revision 变化中止旧工作流。

### 活动优先的原生工具工作流

实现入口为 [Companion](../src/features/ai/companion.tsx) 与 [companion.ts](../src/lib/ai/companion.ts)，复用现有 Service / 签名续传、matchQuery、comparePets、高德 searchPlaces 和 ActivityEditor。状态为 idle → extracting → clarifying → searching → recommendations，用户选组局后 organizing → draft，任意失败进入 error，可取消重置或回手动表单。

1. 需求提取与确定性校验后，自动进入search 阶段，该阶段只向模型开放 search_activities。浏览器用已确认条件覆盖工具参数，检查未来 scheduled、剩余名额、时间窗口内完整活动、未舍入的距离上限、地区 / 类型、体型 / 品种及明确排斥条件。未核实的额外硬条件保守排除，不凭描述声称场地允许宠物。软偏好允许部分符合并展示差异，候选最多5条，进入详情由主人自行报名。
2. 查询成功无结果才说明无匹配；工具错误独立展示并回传。用户可从成功查询选择“自己组局”，或在最初明确创建并确认后跳过活动查询；不会自动报名、邀请或发布。
3. organize 阶段按任务开放 search_pets、search_places、check_compatibility、create_activity_draft，模型可以原生并行调用独立查询。search_pets 复用本地硬筛选及可解释匹配分，性格 / 活动软偏好参与排序，未知偏好提示核实；明确排斥不放宽。search_places 调用现有高德周边查询（最多5km），再按确认半径过滤，地点准入始终 unknown；无网络时只能由用户明确选择演示点恢复，不静默填演示成功结果。
4. 宠友 ID 只能取本次真实查询候选，非空推荐名单必须经过 comparePets；仅需地点时可不查宠友，使用空推荐名单。草稿 placeIndex 只指向本次实际候选，不能接受模型坐标；未经查询 / 比较的引用被拒绝。活动标题和说明采用程序的待确认模板，避免模型借草稿编造场地规定。精确日期取原文明确值；仅有粗略范围时草稿起止留空，在原编辑器由主人填写后才可创建。名额沿用手动表单默认6，可编辑，不代表场地可用名额。
5. 全部工具参数严格 Zod 校验，工具执行不导入写命令。结果每类最多5条摘要回传模型，不发送照片、完整 localStorage、住址或参考坐标。客户端维护原地点对象，回传仅名称、索引、来源、大致距离和准入未知等必要信息。
6. 服务端签名上下文绑定匿名会话、workflow / stage、call IDs、历史和15分钟有效期；续传不得替换 workflow。结果必须与待执行 ID / 类型一致，按 role=tool 和 tool_call_id 回传。search 成功后严格总结；organize 的中间成功继续保留工具，草稿成功后才严格总结。任一工具返回 error（含 NEEDS_CLARIFICATION，如未核实的硬约束）时，不论阶段，下一轮都不带工具、只走严格总结，须如实报告失败或澄清，不能用“已查询 / 无结果 / 草稿”等成功状态；此时仍返回工具调用即 AI_TOOL_PROTOCOL。每轮最多3工具、每阶段最多4次模型轮转和9次工具，4轮用户上下文；最终回答只允许受控状态和真实引用白名单。本步没有工具结果（模型未调用工具，含后续追问轮）时只接受“需要补充信息，请查看工具提示。”“请说明要查询宠友、活动还是创建互助草稿。”两种澄清摘要；“已查询”“没有符合条件的结果”、草稿或失败等终态摘要先走一次回答修复（只给出这两种可选值），仍不符返回 AI_INVALID_OUTPUT（[answer.ts](../src/server/ai/answer.ts)）。
7. 用户说“扩大到5公里”等单半径修改视为明确同意，确定性替换半径、保留日期及其他条件，仅重跑当前阶段，不再消耗提取调用。其他复杂修改当前需重新描述和复核，不宣称任意自然语言多轮都完善。模型重复查询使用本阶段缓存；条件 / 身份 / 参考点变更清除缓存，过时回调不展示。
8. 面板内的 [工具调用时间线](../src/features/ai/timeline.tsx)（状态推导见 [timeline.ts](../src/lib/ai/timeline.ts)）按实际发生顺序记录“理解需求 → 每次模型请求 → 每个工具调用 → 流程终止”，每步有进行中 / 完成 / 空结果 / 出错 / 已取消状态、浏览器测得的耗时和程序依据真实结果生成的摘要（如“找到 3 个活动”）；同轮多个工具标“并行”。默认精简视图只列理解需求与工具步骤（进行中的模型请求也显示），展开后含全部模型轮次。只记录真实调用，不展示模型推理或 answer 文本；取消把进行中步骤标为已取消，迟到结果不能改回；时间线是 React 展示状态，不写入 localStorage，“重新开始”、身份或参考条件变化即清空。
9. 草稿只在内存中传入原 ActivityEditor，不新增持久化结构；用户编辑并点击“确认创建活动”才走 create-activity 命令（含主办者自身报名这一原业务规则）。普通手动发帖、档案、地图、活动和互助不依赖 AI。

签名令牌不是加密或认证，不能证明浏览器业务实体真实；当前浏览器是演示数据所有者。只包含本任务必要数据，不建立服务端业务数据库。

### 拍照建档（pet-photo）

入口为档案表单照片区的 [PhotoRecognize](../src/features/ai/photo.tsx)。只有主人点击“识别照片”才会调用：[makeThumbnail](../src/lib/ai/thumbnail.ts) 按 Exif 方向解码后在新 canvas 上绘制（最长边 ≤512px）并重新编码为 JPEG（质量 0.85 → 0.55，≤100KB），原图及其 EXIF / GPS 不离开浏览器；发送前用 [inspectJpeg](../src/lib/ai/jpeg.ts) 自检。浏览器只发 `{image}`（strict Schema，不能附带模型名或其他数据）；服务端 [thumbnailPart](../src/server/ai/client.ts) 再次检查是 JPEG、最长边 ≤512、最短边 ≥16、无 APP1 Exif / XMP，否则 400。

[recognizePetPhoto](../src/server/ai/service.ts) 用视觉组模型（AI_VISION_MODEL，默认 qwen3.8-omni-flash）与 [petPhotoPrompt](../src/server/ai/prompts.ts)（pawmeet-photo-2）调用，抽取式任务可自动重试一次；输出先过 [petPhotoOutputSchema](../src/lib/ai/contracts.ts)（strict：dog、multipleDogs、breed、size、coatColor、features，各带 0–1 置信度，没有健康 / 年龄 / 性格字段），不合法为 AI_INVALID_OUTPUT。再由 [reviewPetPhoto](../src/lib/ai/photo.ts) 做业务审核：不是“确信是一只狗”（非狗、拿不准、多只狗）一律不填、不给建议；每个字段置信度 ≥0.6 为 `accepted`（随“填入表单”自动填入），低于 0.6 但有值为 `suggested`（界面显示“AI 猜测：xx（把握 nn%），请确认”与“采用”按钮，逐项点击才填入），unknown / 混血不填；看起来像诊断、年龄、性格或胖瘦评价的文字不论置信度一律移除，不作为建议。品种置信度 ≥0.6 且在程序写死的 [品种体型表](../src/lib/ai/breeds.ts) 中（含同义名，如比格 / 比格犬 / 米格鲁；每个品种有典型体型 `typical` 与允许范围 `sizes`，萨摩耶、柯基等有争议的允许多个体型）时：模型体型在范围内则保留；不在范围内（不论其置信度）则改为表中典型体型并 `accepted`，记录 `modelValue` 与 `hint`（“体型按比格的典型体型（中型）填入，AI 原判断为小型”），界面在体型一行显示该提示；品种低置信度或在表外时不替换，按置信度规则。表和规则不交给模型。提示语由程序生成，不回显模型原文。浏览器只收到审核后的草稿（petPhotoDraftSchema）。

“填入表单（尚未保存）”只写入 `accepted` 字段：品种、体型和“外观：毛色、特征”（追加到见面前的小提醒）；每个“采用”只写入对应一个字段。两者都沿用 `data-ai-filled` 标记，手改即清除；点击“确认保存档案”才走原 save-pet 命令。失败（未配置、超时、额度、Schema 不过）显示真实错误码，表单仍可完整手填。

### 社区 AI（post-meta / post-safety）

入口为发帖页的 [PostMetaAssist 与 PrecheckPanel](../src/features/community/compose-ai.tsx)，由 [PostEditor](../src/features/forms/post-form.tsx) 组合；模型选择沿用配置（文本 AI_MODEL、视觉 AI_VISION_MODEL，均在白名单内），不写死厂商。

- 标题 / 标签草稿：只有点击“AI 生成标题和标签”才调用；输入是正文，勾选“同时参考第一张照片”时附带 [makeThumbnail](../src/lib/ai/thumbnail.ts) 生成的缩略图（服务端同样经 thumbnailPart 复查）。[generatePostMeta](../src/server/ai/service.ts) 使用 postMetaPrompt（COMMUNITY_PROMPT_VERSION pawmeet-community-1），输出先过 strict [postMetaOutputSchema](../src/lib/ai/contracts.ts)，再由 [reviewPostMeta](../src/lib/ai/community.ts) 审核：标题去引号后须 1–20 字（不截断，超长即 AI_INVALID_OUTPUT）；标签去 #、去空白后须符合帖子标签格式，重复、超出 5 个、含正文没有出现过的健康 / 身份词（疫苗、过敏、兽医、认证、博主等）或命中个人信息 / 导流规则的被去掉并计数，剩余不足 3 个即失败；提示语同样过滤。草稿经 `fillForm` 写入标题与标签输入框并带 `data-ai-filled`，手改清除，点击发布才走原 publish-post 命令。
- 发布前预检：点“确认发布动态”先过 postInputSchema，再执行 [rulePrecheck](../src/domain/moderation.ts)（纯函数，浏览器运行，全角数字 / 字母先按等长归一化，片段取用户原文）：手机号（含空格 / 横线 / +86）、座机、身份证、微信 / QQ 号、门牌级地址为个人信息（阻止）；外链与域名、加微信 / 扫码 / 进群、代购 / 宠物买卖、辱骂词、虐待动物、给宠物喂人用药或有毒食物为建议，后三类在同一分句内紧邻“别 / 不要 / 千万不”等否定时不报。有阻止项时不调用模型；否则调用 [precheckPost](../src/server/ai/service.ts)（postSafetyPrompt，strict [postSafetyOutputSchema](../src/lib/ai/contracts.ts)），[reviewPostSafety](../src/lib/ai/community.ts) 把 pass 但带问题的输出改为 revise、拒绝无原因的 revise，片段不是原文连续子串时去掉高亮只保留理由；AI 结论一律为非阻止建议。两层都未发现问题才直接发布；否则显示逐条结果（类别、来源、片段上下文高亮、理由），按 [D025](DECISIONS.md) 提供“去修改”“仍要发布”或“重试 AI 预检 / 不经 AI 预检发布”。结果以 [precheckKey](../src/domain/moderation.ts) 绑定所查内容，表单任一修改或 AI 填入即清除结果、中止进行中的预检，迟到结果丢弃；预检状态不持久化。

### 公开 Demo 保护

仅支持一个Node进程 / 实例。APP_ORIGIN精确同源与Fetch Metadata检查，HttpOnly、SameSite=Strict签名匿名cookie；HTTPS生产cookie使用Secure。身份切换不重置额度。DEMO_SESSION_SECRET可配置，缺省从服务端Qwen key签名，轮换key将使旧对话失效。匿名机制不是认证，不能阻止脚本直连。

额度全局10次/分钟、每日最多200次；每session 6次/分钟、20次/日；并发2。全局限制覆盖每个来源IP，忽略不可信IP header，不保存地址。每次尝试按 [estimateTextTokens](../src/lib/ai/estimate.ts)（ASCII 每字符 1、常用中日韩字符 1.5、其他字符按 UTF-8 字节）+ 图片 Token + 该型号最大输出保守预留token，日上限300000，可通过环境降低。缺usage也不退款，不将该账本解释为人民币硬保证。

.runtime/ai-quota.json按mutex串行、临时写入和原子rename，在上游前持久预留；损坏或写失败fail closed，重启不清零。多进程 / serverless 不得沿用该账本；部署属于未授权Phase 5。平台配额也须独立限制。

普通 Playwright 服务显式 AI_ENABLED=false；所有日常测试使用 mock。历史 live runner / 页面套件默认阻断，需用户先明确批准，再由操作者设置 PAWMEET_ALLOW_LIVE_AI=approved；每轮按用户明确授权限制实际传输数（包含重试），不沿用历史批准或旧大批量命令。companion专用冒烟硬上限6，其他live套件上限3；上限不等于授权。实际用量、失败及真实 / mock 边界见 AI_EVAL。

## 7. 高德地图接入

- [MapCanvas](../src/features/maps/map-canvas.tsx) 进入地图视图 / 选点器后才加载 JS API 2.0；默认参考点 GCJ02 `[120.206,30.212]`（杭州滨江公共区域），显式设置 center，不默认定位。首屏不申请定位；点击“使用当前位置”后才调用，拒绝 / 超时 / 转换失败保留原参考点。
- JS Key 是浏览器可见凭据，用 `NEXT_PUBLIC_AMAP_JS_KEY`，配置官网支持的域名限制 / 配额；`AMAP_SECURITY_JSCODE` 仅服务端。loader 前设置 `_AMapSecurityConfig.serviceHost = location.origin + '/_AMapService'`，前端不放 securityJsCode。
- Next Node Route 使用物理目录 `app/%5FAMapService`，对外 URL `/_AMapService`。固定 HTTPS 上游 `restapi.amap.com`，仅 GET `v3/place/around`、`v3/geocode/regeo`、`v3/assistant/coordinate/convert`、SDK 初始化 `v3/log/init`；不启用自定义样式代理。参数白名单由真实 SDK 请求校对（包括两项 `s`、children / type_ / antiCrab）；客户端 key / jscode 全部丢弃再追加服务端值，其余仅 `s` 最多两项、其他重名拒绝。查询长度≤3000、普通单值≤800、POI≤20、第一页、半径≤5000m，callback 限标识符；不接受任意 host / URL / 路径或重定向。上游只接收配置源的 Referer，不透传客户端 Cookie / 任意 header。
- [HTTPS 适配器](../src/server/maps/http.ts) 使用 Node 原生 HTTPS、12 秒总超时、512000 字节响应上限；客户端服务等待 15 秒。响应不透传上游 header；安全码回显拒绝，连接错误只记录错误码，不记录 URL / 密钥 / 地址正文。失败和超时显式返回 502 / 504，无成功样例替换。
- 代理校验 APP_ORIGIN 与请求 Origin / Referer、拒绝 cross-site；不信任客户端 IP header。全局 **60 次 / 分钟**（比原每 IP 上限更严格）、**3000 次 / 北京自然日**，独立于 AI 额度；`.runtime/map-quota.json` 串行预留并原子替换，重启不归零，损坏 / 不可写 fail closed。只支持单 Node 进程单实例，仍须配平台配额，不能保证人民币费用上限。
- 使用 PlaceSearch.searchNearBy 和 Geocoder.getAddress；不加载未使用的 AutoComplete。标准化为 PlaceRef，展示名称 / 地址 / 地点标记与来源，不长期缓存整套 POI。搜索 debounce 300ms、单次≤20；查询序号丢弃过时回调（SDK 已发出的网络请求无法撤回）。选点后必须点击“确认使用该地点”，再由业务表单提交保存。
- 类型入口：公园、宠物医院、宠物店、咖啡店；普通 POI 一律宠物准入 unknown。空结果、SDK 加载失败、key 配置错、配额错都显示可识别状态；地图不可用仍可人工选择明确标记的演示公共地点，不能伪装在线 POI。
- 演示点与选点统一 GCJ02（经度在前）。原生 browser geolocation WGS84 经官方 `convertFrom(...,'gps')` 转换一次；当前不使用 AMap.Geolocation，也没有自定义偏移算法。未归一化的坐标不进入查询；转换失败不采用原始 WGS84。
- `discoverQuery` 的同一结果数组驱动 marker 和列表；选中 ID 双向联动，显示范围圈。更新条件只替换覆盖物，卸载销毁地图和事件；共享加载 Promise，异步加载结束前卸载不会创建地图。地图模式同时保留卡片，失败仍可筛选与查看名片。
- 地点卡“一键高德导航”采用官方 URI 路径规划链接，编码名称、目标 GCJ02 坐标；新窗口安全打开，手机可调起 App / 网页，桌面打开网页版。仅传目标公共地点，不把家庭住址或真实位置放进分享链接。
- 宠物位置始终是虚构公共区域点；浏览器当前位置仅作当前参考，不持久化为宠物位置，不发送 Qwen。创建活动 / 互助只保存用户主动确认的公共集合点。
- 地图不可用可选演示点或文字公共点。文字地点保持 `location=null`，不借用参考点或演示坐标，不生成导航链接；已有自选 POI 编辑后保持原来源与坐标，不回落为默认演示点。

## 8. 环境配置与部署

已提供 [.env.example](../.env.example)。地图与AI配置均已接入，实际服务状态见AI_EVAL；配置步骤见 [README](../README.md#本地运行)：

| 变量 | 可见性 / 用途 |
| --- | --- |
| DASHSCOPE_API_KEY、GEMINI_API_KEY、AI_MODEL、AI_VISION_MODEL、AI_BASE_URL | 服务端；key默认空（只需配置所选型号所属厂商的 key），文本默认qwen3.8-flash、视觉默认qwen3.8-omni-flash（均须在白名单内），AI_BASE_URL 只作用于百炼；旧GLM配置不再使用 |
| AI_STREAM、AI_FIRST_BYTE_TIMEOUT_MS、AI_TOTAL_TIMEOUT_MS | 服务端；默认 true / 15000 / 40000；非法值或首字节大于总时长时返回 AI_CONFIG |
| AI_ENABLED、AI_MAX_DAILY_CALLS、AI_MAX_DAILY_TOKENS | 服务端；未配置密钥默认关闭 AI |
| DEMO_SESSION_SECRET、QUOTA_STORE_PATH | 服务端；签名与可写持久化账本文件 |
| APP_ORIGIN | 服务端；精确线上同源值 |
| NEXT_PUBLIC_AMAP_JS_KEY | 浏览器公开；仍限制来源，真实值不入 Git |
| AMAP_SECURITY_JSCODE | 服务端；禁止 NEXT_PUBLIC 前缀 |

当前暂不部署，只在本地运行演示（见 [DECISIONS D012](DECISIONS.md)）。以下为未来如需部署的参考方案：国内网络可达的香港区域 Linux Node 单实例 + HTTPS 反向代理，自带持久磁盘，无云数据库；须用户另行授权服务商 / 域名和预算。内地部署、域名 / 接入要求按选定平台官方说明核查后决定；不在 Phase 0 承诺合规状态或零费用。Vercel 只作备选，需解决持久限额和国内可达性再采用。不能静态导出，因为 AI / 高德代理需要 Node 服务。

不自动部署、不自动购买。代码和图片本地托管，不依赖 Google Fonts 或海外图片热链。HTTPS 为定位与文件分享能力提供基础，浏览器不支持的分享自动降级下载。上线前在国内移动 / 桌面网络实测首页、Qwen、高德、导航和冷启动；开发机成功不代表国内 HR 可访问。

## 9. 外部依据与待验证项

以下官方资料于 2026-10-17 查阅；高德准备、安全代理、POI、坐标转换和 URI 已于本阶段重新核对。实现与真实联调证据见 PROGRESS，已执行真实Qwen评测，存在失败与未完成项。

- [Next.js 安装](https://nextjs.org/docs/app/getting-started/installation)：App Router 与环境要求；版本最终以 Phase 1 lockfile / 构建为准。
- [Next.js 项目结构](https://nextjs.org/docs/app/getting-started/project-structure)：下划线路由需使用 `%5F` 目录前缀，避免被识别为私有目录。
- [Qwen3.8-Flash](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)、[OpenAI兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)、[Function Calling](https://help.aliyun.com/zh/model-studio/qwen-function-calling)：核验模型ID qwen3.8-flash，支持 JSON 输出与原生工具调用；地域与密钥需匹配。
- [Qwen-Omni](https://help.aliyun.com/zh/model-studio/qwen-omni)、[视觉理解](https://help.aliyun.com/zh/model-studio/vision)（2026-10-19 查阅）：3.8-omni-flash 可非流式、默认思考、reasoning_effort none 关闭、不支持 JSON Schema；3.5-omni 仅流式、无思考；Base64 / 尺寸限制与图片 Token 计算（smart_resize，32×32 +2）。
- [Gemini OpenAI 兼容](https://ai.google.dev/gemini-api/docs/openai)、[图片理解](https://ai.google.dev/gemini-api/docs/image-understanding)、[媒体分辨率](https://ai.google.dev/gemini-api/docs/media-resolution)（2026-10-19 查阅）：image_url base64 data URL、内嵌请求 ≤20MB、Gemini 3 默认每图 ≤1120 Token、思考不可关闭。
- [高德安全密钥](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)：serviceHost 服务端代理方案。
- [高德准备](https://lbs.amap.com/api/javascript-api-v2/prerequisites)、[官方 GPS 转换](https://lbs.amap.com/api/javascript-api-v2/guide/transform/convertfrom)：JS 平台 Key / 安全密钥与 convertFrom。
- [高德坐标基础类](https://lbs.amap.com/api/javascript-api-v2/guide/abc/basetype)、[定位](https://lbs.amap.com/api/javascript-api-v2/guide/services/geolocation)：坐标口径与定位能力。
- [POI 搜索](https://lbs.amap.com/api/javascript-api-v2/guide/services/autocomplete)、[URI 路径规划](https://lbs.amap.com/api/uri-api/guide/travel/route)：地点与导航接口。

本机 Chromium 的实际检查、SDK mock 与真实高德结果分别维护在 [PROGRESS](PROGRESS.md)。待验证：未通过的真实地图子项、物理 GPS 与系统高德 App 唤起、平台额度耗尽、Safari / Android 真机、国内网络；Qwen稳定性 / 全量通过与部署仍未验证。不能用文档推理、mock 或 HTTP 200 代替真实渲染 / 联调证据。
