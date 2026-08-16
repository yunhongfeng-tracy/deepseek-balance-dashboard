// DeepSeek 余额与 token 用量看板 —— 主机半（Node 进程）
//
// 职责：
//   1. 监听 `llm/stream`（global），把每次 DeepSeek 模型调用的 usage 按天累加
//   2. 把每日 token 用量持久化到本地 JSON 文件（跨重启保留）
//   3. 注册 HTTP 路由 `/api/deepseek-balance`，供浏览器端查询余额 + token 用量
//
// 依赖（DSH 主机服务）：credentials / subprocess / fs / sandboxPolicy / webServer / timer

function num(v) {
  const n = parseFloat(v)
  return isFinite(n) ? n : 0
}
function pad2(n) { return n < 10 ? '0' + n : '' + n }
function dayKey(ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

const ENV_REF = 'DEEPSEEK_API_KEY'
const TOKEN_FILE = '.dsh-deepseek-token-usage.json'
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

export const name = 'deepseek-balance-dashboard'
export const inject = ['webServer', 'timer']

export function apply(ctx) {
  const credentials = ctx.get('credentials')
  const subprocess = ctx.get('subprocess')
  const fs = ctx.get('fs')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const cwd = (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot.length > 0)
    ? sandboxPolicy.workspaceRoot
    : process.cwd()

  // 每日 token 用量：{ 'YYYY-MM-DD': { input, output, total } }
  const tokenDaily = {}
  let tokenTarget = null
  let savePending = false

  async function loadTokenDaily() {
    if (!fs) return
    try {
      const target = await fs.resolve(TOKEN_FILE, { cwd })
      tokenTarget = target
      const text = await fs.readText(target)
      const obj = JSON.parse(text)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const k in obj) {
          if (!tokenDaily[k] && obj[k] && typeof obj[k].total === 'number') tokenDaily[k] = obj[k]
        }
      }
    } catch (e) { /* 文件不存在或损坏时忽略 */ }
  }

  function persistTokenDaily() {
    if (!fs || !tokenTarget) return
    const snap = {}
    for (const k in tokenDaily) snap[k] = tokenDaily[k]
    fs.writeText(tokenTarget, JSON.stringify(snap)).catch(function () {})
  }

  function scheduleSave() {
    if (savePending) return
    savePending = true
    ctx.timeout(function () {
      savePending = false
      persistTokenDaily()
    }, 3000)
  }

  function recordUsage(usage) {
    try {
      const input = num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)
      const output = num(usage.outputTokens)
      const reasoning = num(usage.reasoningTokens)
      const total = input + output + reasoning
      if (total <= 0) return
      const dk = dayKey(Date.now())
      const e = tokenDaily[dk] || (tokenDaily[dk] = { input: 0, output: 0, total: 0 })
      e.input += input
      e.output += (output + reasoning)
      e.total += total
      scheduleSave()
    } catch (e) {}
  }

  // 监听每一次模型调用，捕获 usage 分片（global 绕过作用域过滤）
  ctx.on('llm/stream', function (options, next) {
    const upstream = next()
    return (async function* () {
      for await (const chunk of upstream) {
        try {
          if (chunk && chunk.type === 'usage' && chunk.usage) recordUsage(chunk.usage)
        } catch (e) {}
        yield chunk
      }
    })()
  }, { global: true })

  loadTokenDaily()

  async function resolveCurl() {
    try { return await subprocess.resolveExecutable('curl') } catch (e) {}
    try { return await subprocess.resolveExecutable('curl.exe') } catch (e) {}
    return null
  }

  async function fetchBalance() {
    if (credentials === undefined) return { ok: false, error: '凭据服务不可用' }
    const hit = await credentials.resolve(ENV_REF)
    if (!hit || typeof hit.value !== 'string' || hit.value === '') {
      return { ok: false, error: '未找到 DeepSeek API Key（凭据 ' + ENV_REF + ' 未配置）' }
    }
    const apiKey = hit.value
    const curlPath = await resolveCurl()
    if (curlPath === null) return { ok: false, error: '未找到 curl 可执行文件' }
    const handle = subprocess.spawn({
      argv: [curlPath, '-sS', '--max-time', '20', '-H', 'Authorization: Bearer ' + apiKey, BALANCE_URL],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: 5000
    })
    const outcome = await handle.done
    const stdoutText = (handle.collected && handle.collected.stdout) ? handle.collected.stdout.readFrom(0).text : ''
    const stderrText = (handle.collected && handle.collected.stderr) ? handle.collected.stderr.readFrom(0).text : ''
    if (outcome.exitCode !== 0) {
      const detail = (stderrText || stdoutText || '').trim().slice(0, 300)
      return { ok: false, error: '请求失败 (exit ' + outcome.exitCode + ')' + (detail ? ': ' + detail : '') }
    }
    let parsed = null
    try { parsed = JSON.parse(stdoutText) } catch (e) {
      return { ok: false, error: '无法解析 DeepSeek 返回: ' + (stdoutText || '').trim().slice(0, 300) }
    }
    if (!parsed || !Array.isArray(parsed.balance_infos) || parsed.balance_infos.length === 0) {
      return { ok: false, error: '响应缺少余额数据（Key 可能无效）: ' + (stdoutText || '').trim().slice(0, 300) }
    }
    const info = parsed.balance_infos[0] || {}
    const td = {}
    for (const k in tokenDaily) td[k] = tokenDaily[k]
    return {
      ok: true,
      available: parsed.is_available === true,
      currency: typeof info.currency === 'string' ? info.currency : '',
      total: num(info.total_balance),
      granted: num(info.granted_balance),
      topped: num(info.topped_up_balance),
      keySource: typeof hit.source === 'string' ? hit.source : '',
      tokenDaily: td
    }
  }

  // 供浏览器端调用的查询路由（客户端 fetch('/api/deepseek-balance')）
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/deepseek-balance',
    handler: async (req, res) => {
      try {
        const result = await fetchBalance()
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err && err.message) || String(err) }))
      }
    }
  })
}
