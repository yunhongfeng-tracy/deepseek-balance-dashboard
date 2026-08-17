# DeepSeek Balance Dashboard

一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件：在**设置面板**里展示 DeepSeek API 的余额，以及近 6 个月的 token 用量热力图（GitHub 贡献图风格）。

![插件截图](docs/screenshot.png)

## 功能

- **余额**：总余额 / 充值余额 / 赠送余额；先用 Host 全局快照快速显示，再在后台读取 DeepSeek 官方 `/user/balance` 无感更新
- **Token 用量热力图**：近 6 个月，横轴月份、纵轴周一~周日；颜色深浅 = 当日 token 用量（无数据格子在浅色/深色主题下均有独立底色和边框区分）
- **悬停气泡**：黑底白字，展示某天的日期、token 数、费用；支持鼠标悬停和键盘聚焦（Tab + Enter）
- **历史估算口径标记**：历史版本统计口径不同的日期以琥珀色描边区分，悬停气泡与统计卡片同步标注
- **全局费用历史**：余额快照保存在 `$DSH_HOME`，跨浏览器、workspace 和 Host 重启保留；升级时自动导入当前浏览器已有的本地历史
- **4 个统计卡片**：累计 Token / 峰值 Token（带日期）/ 峰值费用 / 今日 Token
- **自动追踪**：监听 `llm/stream`，把 DeepSeek 官方 provider 的真实 Token 用量按天累加并持久化到全局文件
- **重连自恢复**：Host/WebSocket 重连后立即刷新；失败时保留上次成功数据并显示提示
- **多进程安全**：Token 与费用文件使用跨进程锁、读合并写和退出 flush，避免 Web/Headless 同时运行时互相覆盖

## 前置条件

1. 已安装 **DSH**（DeepSeek Harness）
2. DSH 里已配置 DeepSeek API Key（`DEEPSEEK_API_KEY` 凭据；DSH 默认用它跑模型，一般已配置好）

## 安装（永久生效，推荐）

> 安装后 DSH 每次启动都会自动加载本插件，无需重复操作。

### 方式一：让 DSH 代理自己装（最省事）

直接把本仓库的链接丢给 DSH 里的代理，对它说：

> 帮我安装这个 DSH 插件：https://github.com/yunhongfeng-tracy/deepseek-balance-dashboard ，按它的 README 安装。

DSH 代理会按下面「方式二」的步骤自动完成安装。

### 方式二：手动安装

```bash
# 1. 安装插件包，让 DSH 的 loader 能解析到它。
#    关键点：必须装在「DSH 配置目录的 node_modules 解析链」上。
#    对默认配置（DSH_HOME = ~/.dsh），推荐链接到 profiles/node_modules：
mklink /J "%USERPROFILE%\.dsh\profiles\node_modules\deepseek-balance-dashboard" "你的仓库绝对路径\deepseek-balance-dashboard"
```

> 若 DSH 装在全局 npm（`C:\Users\<你>\AppData\Roaming\npm\node_modules`），也可 `npm install -g git+https://github.com/yunhongfeng-tracy/deepseek-balance-dashboard.git`。

```yaml
# 2. 在 DSH 的配置层加一行。对 web 界面（GUI）：
#    编辑 $DSH_HOME/profiles/web/cordis.patch.yml（若用 headless：profiles/headless/cordis.patch.yml）：
- insert:
    - id: deepseek-balance-dashboard
      name: 'deepseek-balance-dashboard'
```

> 如果 DSH 的 loader 找不到包名，把 `name` 换成包的实际路径即可，例如：
> `name: 'file:///path/to/deepseek-balance-dashboard'`

```bash
# 3. 重启 DSH（动态配置在启动时组装，必须重启才生效）。
#    客户端半不需要重建 web bundle：DSH 的 client-modules 会在运行时
#    通过 /plugins/deepseek-balance-dashboard/client.js 自动加载 UI。
```

4. 打开设置面板，左侧应出现「**DeepSeek 余额**」一页（和「通用 / 模型 / 插件」并列）。

### 方式三：临时使用（动态插件，进程重启即失效）

如果只想临时看一眼，不打算永久安装，可以让代理用 `cordis_define` + `cordis_run` 在**当前进程**里动态加载插件。它立即生效、免重启，但 **DSH 每次重启后都会消失**，需要重新执行。

## 验证

- 设置页出现「DeepSeek 余额」入口
- 余额卡片显示数字（不是报错）
- 热力图今天的格子有颜色，悬停出现黑底白字气泡

## 常见问题

- **显示「凭据服务不可用」**：这是旧版插件在启动时过早抓取凭据服务导致的
  （`apply` 里 `ctx.get('credentials')` 拿到 `undefined`）。新版已修复：
  `inject` 声明了 `credentials`，且所有服务改为**使用时按需解析**。
  如果仍出现，请**重启 DSH** 让主机半重新加载新代码。
- **显示「未找到 DeepSeek API Key（凭据 DEEPSEEK_API_KEY 未配置）」**：
  在 DSH 设置 → 模型页填入 DeepSeek API Key（会写入 `$DSH_HOME/.credentials.yaml`），
  或在启动 DSH 的 shell 里导出 `DEEPSEEK_API_KEY` 后重启 DSH。
- **余额一直为 0 或显示网络错误**：检查本机 curl 是否可用、能否访问
  `https://api.deepseek.com/user/balance`（部分地区需要代理）。
- **进入页面需要等待一两秒**：官方余额请求受网络延迟影响。v0.2.1 起采用
  stale-while-revalidate：先从 Host 全局快照快速渲染，再在后台请求官方余额并无感替换；
  30 秒内的重复请求会复用 Host 缓存，同时到达的多个请求只启动一次 curl。
  点击“刷新”按钮会绕过 30 秒缓存，强制查询实时余额。
- **Token 数异常大，切换其他模型后仍增长**：旧版没有过滤 provider，会把 GPT、Kimi
  等其他模型的 usage 也算进 DeepSeek，同时重复加入 reasoning token。新版只统计
  `deepseek-official`，并采用 DSH 的标准口径（`outputTokens` 已包含 reasoning）。
  历史记录会保留并标记为“历史估算口径”，新调用从正确口径继续累计。
- **更换 workspace 后某天历史数据消失**：旧版把统计文件放在当时的 workspace。
  新版统一存放在 `$DSH_HOME`，并自动扫描当前 workspace、DSH_HOME 和已注册 workspace
  下的两种旧文件名，迁移后跨 workspace 保留。
- **悬停其他日期仍显示最后一天，或点击其他区域后提示不消失**：旧版循环变量使用
  `var`，所有事件可能引用最后一个格子，同时只依赖 `onMouseLeave` 清理。新版使用
  每格独立绑定，并在点击其他区域、滚动、窗口失焦、隐藏页面或按 Esc 时关闭提示。
- **DSH 重启后看板变成无样式的原始文字**：历史版本会在 Client 重连时移除 CSS，
  但设置页组件可能继续保留。新版使用稳定、幂等的样式标签跨重连保留，并在
  `connection/reset` 后立即重新查询；若查询失败会保留上次成功数据。
- **热力图今天没有格子**：token 数据从插件**安装并重启之后**开始累计，
  之前的历史用量没有接口可查，属正常现象。
- **空格子看不出来**：旧版无数据格子与面板背景同色。新版使用主题自适应的独立底色
  （浅色偏灰、深色微亮）与更明显的边框；历史估算日期带琥珀色描边。
- **页面提示“Host 仍在运行历史版本插件”**：当前 DSH 进程加载的是历史版本插件代码，
  数据接口缺少最新版本字段。重启 DSH（必要时 `Ctrl+F5`）后提示消失。
- **费用历史如何全局化**：新版 Host 会把每次余额查询的快照保存到
  `$DSH_HOME/.deepseek-balance-dashboard-cost-history.json`。升级后首次打开页面时，
  Client 会将当前浏览器已有的 localStorage 历史幂等导入；成功后其它浏览器与 workspace
  都能读取同一份费用数据。费用仍是余额下降量估算，不等同于官方账单。

## 卸载 / 删除

按安装方式对应清理：

### 删除「永久安装」的插件

```bash
# 1. 从 DSH 配置层删除那一行（profiles/web/cordis.patch.yml 或你加过的配置）：
#    - insert:
#        - id: deepseek-balance-dashboard
#          name: 'deepseek-balance-dashboard'

# 2. 删除包链接（如果装的是全局 npm 包则 npm uninstall -g deepseek-balance-dashboard）：
rmdir "%USERPROFILE%\.dsh\profiles\node_modules\deepseek-balance-dashboard"
```

```bash
# 3. （可选）清理已统计的 Token 与费用数据文件：
del "%DSH_HOME%\.deepseek-balance-dashboard-token-usage.json"
del "%DSH_HOME%\.deepseek-balance-dashboard-cost-history.json"
#    若 DSH_HOME 未显式配置，默认目录为 %USERPROFILE%\.dsh。
#    历史 workspace 中可能仍留有 .dsh-deepseek-token-usage.json 或
#    .ds-deepseek-token-usage.json，可按需备份或删除。
```

4. **重启 DSH** 使配置生效（不重启的话旧进程里插件仍在运行）。

### 删除「临时动态插件」

通过 DSH 对话工具：

| 操作 | 命令 | 效果 |
| --- | --- | --- |
| 永久删除 | `cordis_undefine`（传 pluginId） | 停止 + 删除所有版本定义 |
| 临时停用 | `cordis_stop`（传 pluginId） | 只停止效果，定义保留，随时可重新运行 |

## 永久生效方式汇总

| 方式 | 是否重启后保留 | 是否需要重启生效 | 适用场景 |
| --- | --- | --- | --- |
| **方式一/二：装进 DSH 配置（推荐）** | ✅ 永久 | 首次安装需重启 | 长期使用 |
| **方式三：动态插件** | ❌ 进程重启即消失 | 无需重启，立即生效 | 临时体验、快速迭代 |

> 补充：即使按「永久安装」装好，插件源码更新后也要**重启 DSH**（client 半的 bundle rev 在启动时重新计算并下发浏览器）。

## 数据说明

- **余额**：来自 DeepSeek 官方接口，实时准确。
- **token 用量**：DeepSeek 没有公开的"每日用量"接口，本插件通过 `llm/stream` 钩子仅统计 provider 为 `deepseek-official` 的调用，因此从**安装后开始累积**；历史无数据。
- **Token 口径**：输入 = `inputTokens + cacheReadTokens + cacheWriteTokens`；输出 = `outputTokens`。DSH 的 `outputTokens` 已包含 reasoning，插件不会重复加入 `reasoningTokens`。
- **费用**：由连续余额快照的下降量估算，充值/赠送余额变动可能造成短暂失真；并非官方账单。余额快照统一保存在 `$DSH_HOME/.deepseek-balance-dashboard-cost-history.json`（v1），保留近约 6 个月。升级后 Client 会把当前浏览器已有的 localStorage 历史幂等导入 Host。
- **Token 文件**：统一持久化在 `$DSH_HOME/.deepseek-balance-dashboard-token-usage.json`（v3，Host 全局、按天累计）。v1 历史保留并标记为“历史估算口径”，v2 可直接迁移；两种旧文件名会从当前、DSH_HOME 和已注册 workspace 自动扫描。
- **并发写入**：两个 Profile/进程共享同一 DSH_HOME 时，Token 使用内存增量批次，费用使用快照去重；两者都在跨进程锁内先读、合并、再原子写。正常 stop/重载会等待最后一批 flush。

## 目录结构

```
deepseek-balance-dashboard/
├── AGENTS.md         # 项目用途、数据口径与开发验证约束
├── package.json      # 声明 dsh.client（客户端半）
├── lib/
│   ├── index.js      # 主机半：余额查询 + token 统计 + HTTP 路由
│   └── client.js     # 客户端半：设置页 UI
├── docs/
│   └── screenshot.png
└── README.md
```

## License

MIT
