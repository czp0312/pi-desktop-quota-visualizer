# Antigravity 周期额度适配分析 · 0.7.1

## 结论与范围

之前的插件读取 `fetchAvailableModels.models[].quotaInfo.remainingFraction/resetTime`，没有独立周期标识，不能靠倒计时生成 5 小时和 7 天额度。用户指定的 **dsh-cliproxyapi 2.4.2** 则使用 `retrieveUserQuotaSummary`，从 `groups[].buckets[].window` 获取周期。

本次只读分析参考项目的源码、配置声明、测试和说明，不读取真实账号文件，不运行其登录/初始化流程，不修改参考项目。插件保持独立 Google OAuth、多账号；不依赖 DeepSeek Harness 或 CLIProxyAPI 服务。0.7.1 已移除额度诊断与模型读数折叠明细。

参考项目：`https://github.com/new-Beginner/dsh-cliproxyapi`，本机检出 HEAD 短哈希 `e0fc31f`；package.json 声明版本 `2.4.2`。引用以下本地源码行号，不保证远端 main 与本机工作树完全一致。

## 证据 → 发现 → 适配

| 证据 | 发现 | 当前插件对应适配 |
|---|---|---|
| `src/quota.js:7–11` | 汇总端点依次为 daily、sandbox、生产域名 | `lib/antigravity-summary.js` 的 SUMMARY_ENDPOINTS；main.js 按相同顺序有界回退 |
| `src/quota.js:268–277` | POST `retrieveUserQuotaSummary`，请求体包含当前账号项目；成功但空数据仍回退 | main.js 的 collectAntigravity 优先汇总，再回退模型列表；不使用固定项目 |
| `src/quota.js:129–175` | 支持 body JSON 包装；groups/buckets；蛇形/驼峰字段 | unwrapSummary、summaryWindows |
| `src/quota.js:139–142`、`77–79` | `5h / five-hour / five_hour` 与 `weekly / week` 是显式周期 | 窗口分别为 session（300 分钟）和 week（10080 分钟），缺失/未知不创建窗口 |
| `test/quota.test.js:32–48` | 示例 Gemini 短期 80%、周 40% | tests/antigravity-summary.test.js 复用相同字段与包装示例，验证互不混合 |
| `test/quota.test.js:65–70` | 缺失周期不占位 | 每类型每周期仅显示有效返回桶 |
| `src/oauth.js:14–19` | 项目 ID 有三个响应别名 | 扩展实际 projectId/project/cloudaicompanionProject 的字符串或 `{ id }` 解析 |
| `src/oauth.js:29–37` | 参考项目登录时调用 onboardUser 初始化项目 | **未移植**，本插件不创建项目、不写服务端状态 |
| `src/config.js:9`、`src/oauth.js:7–10` | 版本协商标识 antigravity/2.9.1 | 额度请求使用该版本及本插件 0.7.1 标识 |

## 展示与兼容约定

- 来源组名称标明 Gemini，归入 Gemini；其余归入其他，包括 Claude。Gemini/其他为显示分类，不声称是两个官方共享额度池。
- 每个分类分别汇总 5 小时和 7 天；同分类同周期取最低已知剩余，既不累加也不平均；不提供来源组读数折叠明细。
- 独立窗口以 `window` 为准；它存在但未知时不让 displayName 覆盖。剩余比例的数字、合法十进制字符串、百分数字符串和 `{ val }` 包装均支持；负值、越界、空值、布尔值或非法字符串不采用。
- 重置时间读取 reset_time/resetTime，支持 ISO 和秒/毫秒时间戳。最低值并列而重置不同，不给出单一倒计时。账号推荐仍检查原始成员的过期/耗尽状态。
- 汇总成功返回一个有效窗口就停止回退，不为了“补齐”不存在的窗口继续查询。空结果、网络失败、非认证 HTTP 错误进入备用端点；401/403 停止。
- 汇总无有效周期窗口时回退旧模型列表，明确显示「周期未分类」，绝不声称模型回退是 5 小时或周额度。
- 参考项目要求项目存在；本插件沿用无项目 `{}` 查询兼容路径，不生成默认项目。这一路径能否获得汇总额度需要真实账号验证。
- 请求预算：令牌刷新最多 8 秒、项目发现 8 秒、汇总三个端点各 2 秒、模型回退 4 秒，总计名义上限 26 秒，预留面板 30 秒通道开销。

## 权限与数据

新增精确域名：`daily-cloudcode-pa.googleapis.com`、`daily-cloudcode-pa.sandbox.googleapis.com`。仅用于读取周期汇总。安装/加载时需用户批准，现有授权不变；不新增权限类型。

0.7.1 不再生成或缓存诊断摘要，不提供复制入口或 quota.diagnostics 通道。原始接口响应仅在查询期间用于额度解析，不写日志、不自动上传。

## 验证与待确认事项

```bash
npm test
node --check main.js
node --check lib/antigravity-summary.js
git diff --check
```

自动化测试覆盖参考示例、四个窗口、周期缺失、百分数字符串、备用顺序、空成功响应、认证拒绝、时间预算、多账号隔离、卡片显示、旧模型回退，以及诊断/模型明细移除后的中英文与刷新行为。插件另由 PluginCheck/PluginPack 检查与生成安装包。

**上述验证使用模拟响应，不是 Google 真实账号在线验收。** 安装 0.7.1 后刷新确认；若从 0.6.x 升级需批准新增域名。周期未分类表示汇总接口未返回可识别周期窗口。
