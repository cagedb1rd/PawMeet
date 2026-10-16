# PawMeet

遇见同频的毛孩子。一个移动优先的宠物社区 Web Demo：分享日常、认识宠友、相约活动，重点展示大模型在业务流程中的接入与校验。

当前已实现 **Phase 4.6 社区布局与交互重构**，保留 Phase 4 AI 服务、草稿、推荐和原生工具助手，使用 qwen3.8-flash；真实评测仍未达标，Phase 4 未完成，人工验收待用户确认。可体验 5 个模拟身份、25 个虚构宠物档案、社区动态、活动与互助。所有业务操作真实修改当前浏览器的数据，刷新保留；另一浏览器是独立副本。身份切换不是登录，没有真实用户、邀约、交易或云同步。真实接口测试与未验证项见 [PROGRESS](docs/PROGRESS.md)。

## 本地启动

使用 Node.js 24.x 和 npm，在项目根目录运行：

```powershell
npm ci
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。本地业务和距离筛选不需要密钥；在线地图按下节配置。建议使用新版 Chrome / Edge；单个同源标签页持有编辑权，其他标签页只读。关闭原编辑页后刷新即可接管。不支持 Web Locks 的浏览器关闭写入，以保护数据一致性。手机真机访问需另行配置可信 HTTPS，普通局域网 HTTP 不保证定位 / Web Locks / crypto 能力。

生产模式：`npm run build` 后执行 `npm start`。不要同时在相同端口运行开发和生产服务。

## 可以体验

- 首页：双列瀑布流浏览宠物日常，「发现」查看全部帖子，「关注」查看已关注主人的帖子；进入详情点赞或关注作者。右上角搜索帖子标题、正文和用户昵称。
- ＋：发布标题、正文与最多 3 张照片，刷新后保留；无标题的旧帖子以正文首行展示。
- 附近 → 附近宠友：1 / 3 / 5 / 10 公里、品种、体型、性格与活动偏好多选，按大致直线距离排序；地图与列表共享同一集合。卡片可进入名片、档案、偏好比较与约伴。
- 地图：默认杭州滨江，手动切换公共参考点；点击“使用当前位置”才请求浏览器定位，交由高德转换后临时使用。四类普通地点搜索、地址详情、公共集合点选择与高德导航。普通地点的宠物准入均未知。
- 活动：纵向卡片浏览时间、地点、人数与从滨江公共参考点计算的大致距离；创建未来活动，选择地图地点、演示公共点或文字地点，切换身份报名 / 取消报名；组织者可取消活动，历史记录保留。
- 我的：查看个人资料、帖子、关注与粉丝、活动和互助记录；创建、查看、编辑和删除本人宠物，切换演示身份、清理未引用照片，确认后重置演示数据。
- 社交名片：从宠物档案进入，AI 生成草稿或主人手工编辑性格 / 喜好 / 不喜欢的行为 / 习惯和初见建议，确认后下载 PNG 或分享文件；修改档案后须重新确认。
- 附近 → 临时互助：发布临时遛狗 / 简单喂食，确认交接清单，切换身份申请 / 撤回，主人选择帮助者，帮助者标完成后主人再确认，双方可查历史。
- 地图不可用时错误可见，本地列表和距离筛选仍可用；活动 / 互助可填写文字公共点。无坐标的文字地点不能导航。AI 失败会显示错误，保留手工流程；没有真实认证、支付或即时聊天。

删除使用归档机制保留历史引用；有未结束活动、未来开放互助或进行中互助引用的宠物不能删除。可新建一份宠物档案体验完整 CRUD。浏览器清除站点数据会丢失本地记录；损坏 / 未知版本数据会进入恢复界面，支持导出原文，不会自动覆盖。

上传仅支持 JPEG / PNG / WebP：原图 ≤8MiB、最长边压缩至 1280、输出 ≤250KiB，最多 30 张且总量 ≤10MiB。照片保存于 IndexedDB，localStorage 只存引用。静态照片随项目提供，[来源与许可](public/images/SOURCES.md)。

## 高德本地配置

1. 按[官方准备文档](https://lbs.amap.com/api/javascript-api-v2/prerequisites)登录[高德控制台](https://console.amap.com/)，没有账号先注册，并按控制台提示完成认证。
2. 在「应用管理 → 我的应用」创建 PawMeet 应用、添加 Key，服务平台选择 **Web端（JS API）**，取得 JS Key 和安全密钥。不要用 Web 服务 Key 替代 JS Key。
3. 按控制台可用设置限制来源域名，添加实际使用的 localhost / 未来部署域名；核对服务权限、可用配额和授权要求。不自动开通付费服务或购买资源。
4. 复制 `.env.example` 为本地 `.env.local`（已有文件只补对应字段）：`NEXT_PUBLIC_AMAP_JS_KEY` 填 JS Key、`AMAP_SECURITY_JSCODE` 填安全密钥、`APP_ORIGIN` 填完整访问源（协议、主机、端口），例如 `http://localhost:3103`。密钥不要发到聊天或提交 Git。
5. 重启开发服务：`npm run dev -- --port 3103`。生产模式改配置后重新 `npm run build`，再 `npm run start -- --port 3103`。访问源须与 APP_ORIGIN 一致；localhost 和 127.0.0.1 不是同一个源。

安全码只由 Node 的 `/_AMapService` 代理追加；浏览器只得到公开 JS Key。[官方代理说明](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)。代理固定高德上游、限制路径 / 参数，每个 Node 进程全局最多 60 次 / 分钟、3000 次 / 北京自然日，账本在被忽略的 `.runtime/map-quota.json`；只支持单实例单进程，不能当成平台硬费用保证。部署前仍需核对平台配额，禁止多进程共享此账本。

当前位置仅作本页参考，不写入档案、不持久化、不发送给 AI。地图选点只更新表单草稿，提交活动 / 求助后才保存约定公共点。不需要精确家庭位置。重置或首次打开会使用新分布的演示坐标；已有浏览器档案和位置原样保留。

## Qwen 本地配置

在已有 `.env.local` 中配置 `DASHSCOPE_API_KEY`、`AI_MODEL=qwen3.8-flash`、`AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`、`AI_ENABLED=true`；`APP_ORIGIN` 须与浏览器访问源一致。密钥仅在 Next 服务端使用，禁止 `NEXT_PUBLIC` 前缀。配置后重启，生产模式先重新 build。用户已授权使用此型号；它按百炼账户规则计费，不能视为永久免费。程序拒绝其他型号且无自动回退；旧 `GLM_*` 配置不参与调用。

“我的”档案表单支持自然语言提取；名片编辑支持AI草稿；“附近 → 智能找宠友与现有 AI 助手”可描述筛选条件，应用后本地计算结果和偏好分；两宠比较可整理规则解释；互助表单可提取时间 / 时长 / 地点线索，详情可生成照看清单。生成和填入都不保存，主人编辑并确认后才通过原业务流程写入。模糊时间留空，互助公共地点须重新确认。

从“附近 → 智能找宠友与现有 AI 助手”进入原生工具体验：例如“找5公里内温和、喜欢散步的狗狗，也看看滨江区已有活动”。工具查询当前浏览器数据，只有必要的至多5条结果发回Qwen；模型不计算距离或匹配分。互助工具只打开草稿表单，不自动发布。

全局10次/分钟、200次/日、保守token预留300000/日、并发2；session为6次/分钟和20次/日。可以用AI_MAX_DAILY_CALLS / AI_MAX_DAILY_TOKENS降低限制，AI_ENABLED=false关闭调用。账本需要可写持久磁盘、单实例单进程；不是平台费用保证，公开部署仍需平台配额控制。可设置独立DEMO_SESSION_SECRET；不配置则用服务端Qwen key签名。

自动评测（仅虚构fixture）：

```powershell
npm run eval:ai -- --mode mock
npm run eval:ai -- --mode live --dry-run
npm run eval:ai -- --mode live --max-calls 80
# 单例复测；或 --resume evals/reports/<runId>.json 只跳过同模式已通过项
npm run eval:ai -- --mode live --case TC04 --max-calls 8
```

报告保存在evals/reports；真实和模拟不可混算。连续上游错误会熔断，未执行条目标not_run；带未执行或失败不能算阶段通过。原生调用即使成功发出，参数错误 / 工具未执行 / 最终回答失败仍算任务失败。方法和实际失败见[AI_EVAL](docs/AI_EVAL.md)。

## 检查与验收

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
npx playwright install chromium
npm run test:e2e
# 显式真实地图检查（需要上述配置，会访问高德；与 SDK mock 分开）
npm run test:maps:live
```

Playwright 使用生产构建，会在 3000 端口自动启动服务；测试拒绝复用已有服务；默认 3000 端口被占用时，可先设置 `$env:PAWMEET_E2E_PORT='3102'` 再运行测试。真实结果、未验证项和逐步验收清单见 [PROGRESS](docs/PROGRESS.md)。

[产品与验收](docs/PRD.md) · [架构与接口契约](docs/ARCHITECTURE.md) · [阶段计划](docs/PLAN.md) · [交接](docs/HANDOFF.md)
