# DeepSeek Balance Dashboard 项目指令

## 项目用途

本项目是一个 DeepSeek Harness（DSH）插件，在 DSH Web 设置面板中提供“DeepSeek 余额”页面，用于：

- 查询 DeepSeek 官方 API 账户余额，包括总余额、充值余额和赠送余额。
- 按天记录本 DSH 实例通过 DeepSeek 官方 provider 产生的 Token 用量。
- 以近 6 个月热力图展示每日 Token，并提供累计、峰值和今日统计。
- 通过余额快照变化估算每日费用；该费用仅为估算值，不等同于官方账单。

余额来自 DeepSeek 官方 `/user/balance` 接口；每日 Token 并无官方历史查询接口，因此只能从插件安装并启动后开始本地累计。

## 核心结构

- `lib/index.js`：Host 端。解析凭据、查询余额、监听 `llm/stream`、持久化每日 Token，并注册 `/api/deepseek-balance`。
- `lib/client.js`：Client 端。注册设置页、渲染余额卡片、统计卡片和热力图。
- `package.json`：插件元数据、版本和 DSH Client 注入声明。
- `README.md`：面向安装者和使用者的安装、验证、故障排查及卸载说明。

## 数据与统计口径

- API Key 通过 DSH `credentials` 服务解析，引用名为 `DEEPSEEK_API_KEY`。
- Token 只统计 `options.provider === 'deepseek-official'` 的调用；不得把 GPT、Kimi 或其他 provider 的 usage 计入 DeepSeek 看板。
- 输入 Token = `inputTokens + cacheReadTokens + cacheWriteTokens`。
- 输出 Token = `outputTokens`。DSH 的 `outputTokens` 已包含 reasoning；禁止再次加入 `reasoningTokens`。
- Token 文件为工作区下的 `.dsh-deepseek-token-usage.json`，当前使用 v2 数据格式。无法按 provider 拆分的旧版污染数据应清空后重新累计。

## DSH / Cordis 开发约束

- Host 服务必须通过 `inject` 声明启动依赖，或在实际使用时通过 `ctx.get()` 延迟解析；不要在服务尚未激活时永久缓存 `undefined`。
- `llm/stream` 是全局 Hook，必须先过滤 provider，再记录 usage。
- Client CSS 必须使用稳定、幂等的 `data-plugin-css` 标签注入，并跨 `connection/reset` 保留。
- 不要假设 Host 连接 Context、React 组件和 Slot 注册一定同步卸载。
- Host 或 Client 源码更新后必须重启 DSH；浏览器必要时使用 `Ctrl+F5` 重新加载 Client 模块。
- 不得把 API Key、Authorization Header 或完整凭据写入日志、接口错误、截图或 Git 历史。

## 修改后的最低验证要求

1. 对 `lib/index.js` 和 `lib/client.js` 运行 `node --check`。
2. 确认 `/api/deepseek-balance` 返回 `ok: true`，且响应不包含明文 API Key。
3. 验证非 `deepseek-official` usage 不会增加 Token；DeepSeek usage 按标准口径只累计一次。
4. 验证 Client CSS 重复初始化仍只有一个稳定 style 标签。
5. 验证首次打开、Host 重启但浏览器不刷新、WebSocket 重连和 `Ctrl+F5` 后界面均正常。
6. 发布行为变更时同步更新 `package.json` 版本和 `README.md`，检查 Git diff 后再提交。
