import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// DeepSeek 余额与 token 用量看板 —— 主机半（Node 进程）
//
// 职责：
//   1. 监听 `llm/stream`（global），把每次 DeepSeek 模型调用的 usage 按天累加
//   2. 把每日 token 用量持久化到本地 JSON 文件（跨重启保留）
//   3. 注册 HTTP 路由 `/api/deepseek-balance`，供浏览器端查询余额 + token 用量
//
// 依赖（DSH 主机服务）：credentials / subprocess / sandboxPolicy / webServer / timer
// 注意：所有服务都在「使用时」通过 ctx.get() 延迟解析（见 svc()），
// 而不是在 apply 时缓存实例——否则加载顺序稍有不符就会拿到 undefined。

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
const DEEPSEEK_PROVIDER = 'deepseek-official'
const TOKEN_SCHEMA_VERSION = 3
const TOKEN_FILE = '.deepseek-balance-dashboard-token-usage.json'
const LEGACY_TOKEN_FILE = '.dsh-deepseek-token-usage.json'
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

export const name = 'deepseek-balance-dashboard'
// 声明注入 credentials：加载器会先等凭据服务激活再运行本插件，
// 从根上避免「apply 时 ctx.get('credentials') 拿到 undefined」的问题。
export const inject = ['webServer', 'timer', 'credentials']

export function apply(ctx) {
  // 按需取服务：每次使用时重新查一次，确保拿到已激活的实例。
  const svc = (n) => ctx.get(n) || null
  const cwd = (() => {
    const sp = svc('sandboxPolicy')
    return (sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot.length > 0)
      ? sp.workspaceRoot
      : process.cwd()
  })()
  // Token 是 Host 全局统计，不应随当前 workspace 改变。稳定存储放在 DSH_HOME；
  // cwd 只保留给 curl 工作目录及当前 workspace 的旧文件迁移。
  const dshHome = (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim())
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')

  // 每日 token 用量：{ 'YYYY-MM-DD': { input, output, total } }
  const tokenDaily = {}
  const legacyDates = new Set()
  const tokenTarget = join(dshHome, TOKEN_FILE)
  let savePending = false
  let writeChain = Promise.resolve()

  function parseTokenPayload(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    if (obj.version === TOKEN_SCHEMA_VERSION && obj.provider === DEEPSEEK_PROVIDER
      && obj.daily && typeof obj.daily === 'object' && !Array.isArray(obj.daily)) {
      return {
        version: TOKEN_SCHEMA_VERSION,
        daily: obj.daily,
        legacyDates: Array.isArray(obj.legacyDates) ? obj.legacyDates : []
      }
    }
    // v2 已按 DeepSeek provider 和 DSH 标准口径统计，只是文件仍绑定 workspace。
    if (obj.version === 2 && obj.provider === DEEPSEEK_PROVIDER
      && obj.daily && typeof obj.daily === 'object' && !Array.isArray(obj.daily)) {
      return { version: 2, daily: obj.daily, legacyDates: [] }
    }
    // v1 顶层直接保存每日数据。它混入过其他 provider 且 reasoning 可能重复，
    // 但历史日期不应静默消失；保留原值并在 UI 标记为“旧版口径”。
    return { version: 1, daily: obj, legacyDates: Object.keys(obj) }
  }

  function mergeTokenPayload(parsed) {
    if (!parsed) return 0
    const legacy = new Set(parsed.legacyDates)
    let added = 0
    for (const k in parsed.daily) {
      const source = parsed.daily[k]
      if (!source || typeof source.total !== 'number' || tokenDaily[k]) continue
      tokenDaily[k] = { input: num(source.input), output: num(source.output), total: num(source.total) }
      if (legacy.has(k)) legacyDates.add(k)
      added++
    }
    return added
  }

  async function readTokenPayload(filename) {
    try {
      return parseTokenPayload(JSON.parse(await readFile(filename, 'utf8')))
    } catch (e) {
      return null
    }
  }

  async function discoverLegacyFiles() {
    const paths = new Set([resolve(cwd, LEGACY_TOKEN_FILE)])
    try {
      const registry = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
      const workspaces = registry && registry.tables && registry.tables.workspaces
      if (workspaces && typeof workspaces === 'object') {
        for (const id in workspaces) {
          const workspacePath = workspaces[id] && workspaces[id].path
          if (typeof workspacePath === 'string' && workspacePath.trim()) {
            paths.add(resolve(workspacePath, LEGACY_TOKEN_FILE))
          }
        }
      }
    } catch (e) { /* workspace registry 不存在或格式变化时只迁移当前 cwd */ }
    return Array.from(paths)
  }

  async function loadTokenDaily() {
    let needsPersist = false
    // v3 的稳定文件始终位于 DSH_HOME，不再随当前 workspace 漂移。
    const stable = await readTokenPayload(tokenTarget)
    if (stable) {
      mergeTokenPayload(stable)
      if (stable.version !== TOKEN_SCHEMA_VERSION) needsPersist = true
    }

    // 兼容迁移当前 workspace 及 DSH 注册过的 workspace 下的 v1/v2 文件。
    // 稳定文件中的同日期优先，防止重复导入或覆盖新口径数据。
    const legacyFiles = await discoverLegacyFiles()
    for (const filename of legacyFiles) {
      const legacy = await readTokenPayload(filename)
      if (legacy && mergeTokenPayload(legacy) > 0) needsPersist = true
    }

    if (needsPersist) await persistTokenDaily()
  }

  async function writeTokenPayload(text) {
    await mkdir(dirname(tokenTarget), { recursive: true })
    const temp = tokenTarget + '.tmp-' + process.pid + '-' + Date.now()
    await writeFile(temp, text, 'utf8')
    try {
      await rename(temp, tokenTarget)
    } catch (e) {
      // Windows 上目标文件被占用时回退为直接覆盖，同时清理临时文件。
      await writeFile(tokenTarget, text, 'utf8')
      await unlink(temp).catch(function () {})
    }
  }

  function persistTokenDaily() {
    const snap = {}
    for (const k in tokenDaily) snap[k] = tokenDaily[k]
    const payload = {
      version: TOKEN_SCHEMA_VERSION,
      provider: DEEPSEEK_PROVIDER,
      daily: snap,
      legacyDates: Array.from(legacyDates).sort()
    }
    const text = JSON.stringify(payload)
    writeChain = writeChain.then(function () { return writeTokenPayload(text) }).catch(function (error) {
      ctx.logger.warn('deepseek-balance-dashboard: failed to persist token usage')
      ctx.logger.warn(error)
    })
    return writeChain
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
      // DSH 的 TokenUsage 口径中，outputTokens 已包含 reasoningTokens；
      // reasoningTokens 仅用于细分展示，不能再次加入总量。
      const input = num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)
      const output = num(usage.outputTokens)
      const total = input + output
      if (total <= 0) return
      const dk = dayKey(Date.now())
      const e = tokenDaily[dk] || (tokenDaily[dk] = { input: 0, output: 0, total: 0 })
      e.input += input
      e.output += output
      e.total += total
      scheduleSave()
    } catch (e) {}
  }

  const loadPromise = loadTokenDaily().catch(function (error) {
    ctx.logger.warn('deepseek-balance-dashboard: failed to load token usage')
    ctx.logger.warn(error)
  })

  // global 能覆盖所有会话/子代理，但只统计 DeepSeek 官方 provider。
  // 未过滤 provider 会把 GPT、Kimi 等其他模型的 usage 错算进 DeepSeek 看板。
  ctx.on('llm/stream', function (options, next) {
    const upstream = next()
    if (!options || options.provider !== DEEPSEEK_PROVIDER) return upstream
    return (async function* () {
      for await (const chunk of upstream) {
        try {
          if (chunk && chunk.type === 'usage' && chunk.usage) {
            await loadPromise
            recordUsage(chunk.usage)
          }
        } catch (e) {}
        yield chunk
      }
    })()
  }, { global: true })

  async function resolveCurl() {
    const subprocess = svc('subprocess')
    if (!subprocess) return null
    try { return await subprocess.resolveExecutable('curl') } catch (e) {}
    try { return await subprocess.resolveExecutable('curl.exe') } catch (e) {}
    return null
  }

  async function fetchBalance() {
    await loadPromise
    const credentials = svc('credentials')
    if (!credentials) return { ok: false, error: '凭据服务不可用' }
    const hit = await credentials.resolve(ENV_REF)
    if (!hit || typeof hit.value !== 'string' || hit.value === '') {
      return { ok: false, error: '未找到 DeepSeek API Key（凭据 ' + ENV_REF + ' 未配置）' }
    }
    const apiKey = hit.value
    const curlPath = await resolveCurl()
    if (curlPath === null) return { ok: false, error: '未找到 curl 可执行文件' }
    const subprocess = svc('subprocess')
    if (!subprocess) return { ok: false, error: '子进程服务不可用' }
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
      tokenDaily: td,
      tokenLegacyDates: Array.from(legacyDates).sort()
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
