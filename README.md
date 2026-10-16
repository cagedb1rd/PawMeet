# PawMeet

遇见同频的毛孩子。一个移动优先的宠物社区 Web Demo：分享日常、认识宠友、相约活动，重点展示大模型在业务流程中的接入与校验。

当前完成 **Phase 1 基础人工流程，等待人工验收**。可体验 5 个模拟身份、25 个虚构宠物档案、社区动态与活动。所有开放操作真实修改当前浏览器的数据，刷新保留；另一浏览器是独立副本。身份切换不是登录，没有真实用户、邀约、交易或云同步。

## 本地启动

使用 Node.js 24.x 和 npm，在项目根目录运行：

```powershell
npm ci
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。本阶段不需要密钥。建议使用新版 Chrome / Edge；单个同源标签页持有编辑权，其他标签页只读。关闭原编辑页后刷新即可接管。不支持 Web Locks 的浏览器关闭写入，以保护数据一致性。手机真机访问需另行配置可信 HTTPS，普通局域网 HTTP 不保证 Web Locks / crypto 能力。

生产模式：`npm run build` 后执行 `npm start`。不要同时在相同端口运行开发和生产服务。

## 可以体验

- 首页：浏览动态、发布文字与最多 3 张照片、点赞 / 取消点赞、查看自己的发布。
- 发现：按名称 / 品种 / 区域搜索，按性格标签浏览虚构宠友。
- 活动：创建未来活动，选择演示公共集合点，切换身份报名 / 取消报名；组织者可取消活动，历史记录保留。
- 我的：创建、查看、编辑和删除本人宠物，清理未引用照片，确认后重置演示数据。
- 互助：虚构需求预览。申请、交接与完成流程尚未开放。社交名片、地图、距离匹配、AI 也均未开放。

删除使用归档机制保留历史引用；有未结束活动或开放互助引用的宠物不能删除。可新建一份宠物档案体验完整 CRUD。浏览器清除站点数据会丢失本地记录；损坏 / 未知版本数据会进入恢复界面，支持导出原文，不会自动覆盖。

上传仅支持 JPEG / PNG / WebP：原图 ≤8MiB、最长边压缩至 1280、输出 ≤250KiB，最多 30 张且总量 ≤10MiB。照片保存于 IndexedDB，localStorage 只存引用。静态照片随项目提供，[来源与许可](public/images/SOURCES.md)。

## 检查与验收

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
npx playwright install chromium
npm run test:e2e
```

Playwright 使用生产构建，会在 3000 端口自动启动服务；为保证测试版本准确，运行前先停止已有服务。真实结果、未验证项和逐步验收清单见 [PROGRESS](docs/PROGRESS.md)。

[产品与验收](docs/PRD.md) · [架构与后续接口设计](docs/ARCHITECTURE.md) · [阶段计划](docs/PLAN.md) · [交接](docs/HANDOFF.md)
