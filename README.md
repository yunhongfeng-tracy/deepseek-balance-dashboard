# DeepSeek Balance Dashboard

一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件：在**设置面板**里展示 DeepSeek API 的余额，以及近 6 个月的 token 用量热力图（GitHub 贡献图风格）。

![插件截图](docs/screenshot.png)

## 功能

- **余额**：总余额 / 充值余额 / 赠送余额（实时读取 DeepSeek 官方 `/user/balance` 接口）
- **Token 用量热力图**：近 6 个月，横轴月份、纵轴周一~周日；颜色深浅 = 当日 token 用量
- **悬停气泡**：黑底白字，展示某天的日期、token 数、费用
- **4 个统计卡片**：累计 Token / 峰值 Token（带日期）/ 峰值费用 / 今日 Token
- **自动追踪**：监听 `llm/stream`，把每次模型调用的真实 token 用量按天累加并持久化到本地文件

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
- **Token 数异常大，切换其他模型后仍增长**：旧版没有过滤 provider，会把 GPT、Kimi
  等其他模型的 usage 也算进 DeepSeek，同时重复加入 reasoning token。新版只统计
  `deepseek-official`，并采用 DSH 的标准口径（`outputTokens` 已包含 reasoning）。
  升级后旧版污染数据会自动清空，从正确口径重新累计。
- **热力图今天没有格子**：token 数据从插件**安装并重启之后**开始累计，
  之前的历史用量没有接口可查，属正常现象。

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
# 3. （可选）清理已统计的 token 数据文件：
del "%USERPROFILE%\.dsh\...\dsh-deepseek-token-usage.json"
#    实际路径 = 插件运行时的 cwd（通常是 DSH 的 workspace root）下的
#    .dsh-deepseek-token-usage.json，例如 D:\...\工作目录\.dsh-deepseek-token-usage.json
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
- **费用**：由余额快照下降量估算，充值/赠送余额变动可能造成短暂失真。
- token 数据持久化在插件运行 cwd 下的 `.dsh-deepseek-token-usage.json`（v2 格式，按天累计，跨重启保留；首次从旧版升级会清空无法拆分的污染数据）。

## 目录结构

```
deepseek-balance-dashboard/
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
