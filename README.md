# DeepSeek Balance Dashboard

一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件：在**设置面板**里展示 DeepSeek API 的余额，以及近 6 个月的 token 用量热力图（GitHub 贡献图风格）。

## 功能

- **余额**：总余额 / 充值余额 / 赠送余额（实时读取 DeepSeek 官方 `/user/balance` 接口）
- **Token 用量热力图**：近 6 个月，横轴月份、纵轴周一~周日；颜色深浅 = 当日 token 用量
- **悬停气泡**：黑底白字，展示某天的日期、token 数、费用
- **4 个统计卡片**：累计 Token / 峰值 Token（带日期）/ 峰值费用 / 今日 Token
- **自动追踪**：监听 `llm/stream`，把每次模型调用的真实 token 用量按天累加并持久化到本地文件

## 安装

前提：已安装 DSH，且 DSH 里已配置 DeepSeek API Key（`DEEPSEEK_API_KEY` 凭据，DSH 默认就有）。

```bash
# 1. 安装本插件（GitHub 或 npm）
npm install <你的 GitHub 仓库地址>   # 例如 npm install git+https://github.com/<你>/deepseek-balance-dashboard.git

# 2. 在自己的 cordis.yml 里加一行
#    （宿主组合或 agent preset 均可）
# - id: deepseek-balance-dashboard
#   name: 'deepseek-balance-dashboard'
```

然后重启 DSH（或重新构建 web bundle），打开设置面板即可看到「DeepSeek 余额」一页。

## 数据说明

- **余额**：来自 DeepSeek 官方接口，实时准确。
- **token 用量**：DeepSeek 没有公开的"每日用量"接口，本插件通过 `llm/stream` 钩子统计**本 DSH 实例**实际消耗的 token，因此是从**安装后开始累积**的；历史无数据。
- **费用**：由余额快照下降量估算，充值/赠送余额变动可能造成短暂失真。
- token 数据持久化在 DSH 进程启动目录下的 `.ds-deepseek-token-usage.json`。

## 目录结构

```
deepseek-balance-dashboard/
├── package.json      # 声明 dsh.client（客户端半）
├── lib/
│   ├── index.js      # 主机半：余额查询 + token 统计 + HTTP 路由
│   └── client.js     # 客户端半：设置页 UI
└── README.md
```

## License

MIT
