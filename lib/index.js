import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// DeepSeek 余额、Token 与费用看板 —— Host（Node 进程）
// Token 仅统计 deepseek-official；Token 与余额快照均全局存放在 DSH_HOME。

function num(v) {
  const n = parseFloat(v)
  return isFinite(n) ? n : 0
}
function pad2(n) { return n < 10 ? '0' + n : '' + n }
function dayKey(ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}
function isDayKey(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) }
function sleep(ms) { return new Promise(function (resolveSleep) { setTimeout(resolveSleep, ms) }) }
function resolveDshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  let target = configured || join(homedir(), '.dsh')
  if (target === '~') target = homedir()
  else if (target.startsWith('~/') || target.startsWith('~\\')) target = join(homedir(), target.slice(2))
  return resolve(target)
}

const ENV_REF = 'DEEPSEEK_API_KEY'
const DEEPSEEK_PROVIDER = 'deepseek-official'
const API_SCHEMA_VERSION = 4
const TOKEN_SCHEMA_VERSION = 3
const COST_SCHEMA_VERSION = 1
const TOKEN_FILE = '.deepseek-balance-dashboard-token-usage.json'
const COST_FILE = '.deepseek-balance-dashboard-cost-history.json'
const LEGACY_TOKEN_FILE = '.dsh-deepseek-token-usage.json'
const LEGACY_TOKEN_FILE_OLD = '.ds-deepseek-token-usage.json'
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const HISTORY_RETENTION_MS = 190 * 24 * 60 * 60 * 1000
const HISTORY_MAX = 60000
const BODY_MAX = 512 * 1024
const LOCK_STALE_MS = 30000
const LOCK_WAIT_MS = 10000
const BALANCE_CACHE_MS = 30000

export const name = 'deepseek-balance-dashboard'
export const inject = ['webServer', 'timer', 'credentials']

async function readJson(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')) } catch (e) { return null }
}

async function atomicWriteJson(target, payload) {
  await mkdir(dirname(target), { recursive: true })
  const text = JSON.stringify(payload)
  const temp = target + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  await writeFile(temp, text, 'utf8')
  try {
    await rename(temp, target)
  } catch (e) {
    // Windows 目标文件被占用时，在跨进程锁内直接覆盖仍是单写者安全的。
    await writeFile(target, text, 'utf8')
    await unlink(temp).catch(function () {})
  }
}

async function withFileLock(target, operation) {
  const lockPath = target + '.lock'
  const owner = process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  const deadline = Date.now() + LOCK_WAIT_MS
  let handle = null
  await mkdir(dirname(target), { recursive: true })
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx')
      await handle.writeFile(owner, 'utf8')
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error
      try {
        const lockStat = await stat(lockPath)
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(function () {})
          continue
        }
      } catch (statError) {
        if (!statError || statError.code !== 'ENOENT') await unlink(lockPath).catch(function () {})
        continue
      }
      if (Date.now() >= deadline) throw new Error('等待全局数据文件锁超时: ' + lockPath)
      await sleep(25 + Math.floor(Math.random() * 50))
    }
  }
  // 慢磁盘、杀毒扫描或 workspace 注册表较大时，持续更新 mtime，避免活锁被误判为陈旧锁。
  const heartbeat = setInterval(function () {
    handle.write(owner, 0, 'utf8').catch(function () {})
  }, Math.floor(LOCK_STALE_MS / 3))
  if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref()
  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    await handle.close().catch(function () {})
    try {
      if ((await readFile(lockPath, 'utf8')) === owner) await unlink(lockPath)
    } catch (e) {}
  }
}

function emptyTokenState() { return { daily: {}, legacyDates: new Set() } }
function parseTokenPayload(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  if (obj.version === TOKEN_SCHEMA_VERSION && obj.provider === DEEPSEEK_PROVIDER
    && obj.daily && typeof obj.daily === 'object' && !Array.isArray(obj.daily)) {
    return { version: TOKEN_SCHEMA_VERSION, daily: obj.daily, legacyDates: Array.isArray(obj.legacyDates) ? obj.legacyDates : [] }
  }
  if (obj.version === 2 && obj.provider === DEEPSEEK_PROVIDER
    && obj.daily && typeof obj.daily === 'object' && !Array.isArray(obj.daily)) {
    return { version: 2, daily: obj.daily, legacyDates: [] }
  }
  return { version: 1, daily: obj, legacyDates: Object.keys(obj).filter(isDayKey) }
}
function mergeTokenPayload(state, parsed) {
  if (!parsed) return 0
  const legacy = new Set(parsed.legacyDates)
  let added = 0
  for (const key in parsed.daily) {
    const source = parsed.daily[key]
    if (!isDayKey(key) || !source || typeof source.total !== 'number' || state.daily[key]) continue
    state.daily[key] = { input: num(source.input), output: num(source.output), total: num(source.total) }
    if (legacy.has(key)) state.legacyDates.add(key)
    added++
  }
  return added
}
function tokenPayload(state) {
  const daily = {}
  for (const key in state.daily) daily[key] = state.daily[key]
  return { version: TOKEN_SCHEMA_VERSION, provider: DEEPSEEK_PROVIDER, daily, legacyDates: Array.from(state.legacyDates).sort() }
}
function addTokenDelta(target, delta) {
  for (const key in delta) {
    const source = delta[key]
    const entry = target[key] || (target[key] = { input: 0, output: 0, total: 0 })
    entry.input += num(source.input)
    entry.output += num(source.output)
    entry.total += num(source.total)
  }
}
function cloneTokenDaily(source) {
  const result = {}
  for (const key in source) result[key] = { input: num(source[key].input), output: num(source[key].output), total: num(source[key].total) }
  return result
}

function normalizeSnapshot(source) {
  if (!source || typeof source !== 'object') return null
  const t = Number(source.t)
  const total = Number(source.total)
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(total)) return null
  return {
    t: Math.round(t), total,
    granted: num(source.granted), topped: num(source.topped),
    currency: typeof source.currency === 'string' ? source.currency.slice(0, 16) : ''
  }
}
function snapshotKey(snapshot) { return [snapshot.t, snapshot.total, snapshot.granted, snapshot.topped, snapshot.currency].join('|') }
function mergeSnapshots(existing, incoming) {
  const byKey = new Map()
  for (const source of existing.concat(incoming)) {
    const snapshot = normalizeSnapshot(source)
    if (snapshot) byKey.set(snapshotKey(snapshot), snapshot)
  }
  let history = Array.from(byKey.values()).sort(function (a, b) { return a.t - b.t })
  // 多标签页/多 Profile 往往在同一分钟查询到完全相同的余额；保留较新的一个即可，
  // 避免重复零变化快照挤占 6 个月留存窗口。
  const compacted = []
  for (const snapshot of history) {
    const previous = compacted[compacted.length - 1]
    if (previous && snapshot.t - previous.t <= 60000
      && snapshot.total === previous.total && snapshot.granted === previous.granted
      && snapshot.topped === previous.topped && snapshot.currency === previous.currency) {
      compacted[compacted.length - 1] = snapshot
    } else {
      compacted.push(snapshot)
    }
  }
  history = compacted
  const cutoff = Date.now() - HISTORY_RETENTION_MS
  const first = history.findIndex(function (item) { return item.t >= cutoff })
  if (first > 0) history = history.slice(first - 1)
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX)
  return history
}
function parseCostPayload(obj) {
  if (!obj || obj.version !== COST_SCHEMA_VERSION || !Array.isArray(obj.history)) return []
  return mergeSnapshots([], obj.history)
}
function costPayload(history) { return { version: COST_SCHEMA_VERSION, history } }
function computeCostDaily(history) {
  const result = {}
  const sorted = history.slice().sort(function (a, b) { return a.t - b.t })
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i]
    const key = dayKey(current.t)
    if (!result[key]) result[key] = { spend: 0, currency: current.currency || '' }
    if (current.currency) result[key].currency = current.currency
    if (i > 0) {
      const delta = sorted[i - 1].total - current.total
      if (delta > 0) result[key].spend += delta
    }
  }
  return result
}

async function readJsonBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function apply(ctx) {
  const svc = (serviceName) => ctx.get(serviceName) || null
  const cwd = (() => {
    const policy = svc('sandboxPolicy')
    return policy && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot.length > 0 ? policy.workspaceRoot : process.cwd()
  })()
  const dshHome = resolveDshHome()
  const tokenTarget = join(dshHome, TOKEN_FILE)
  const costTarget = join(dshHome, COST_FILE)
  const logWarning = (message, error) => {
    if (!ctx.logger || typeof ctx.logger.warn !== 'function') return
    ctx.logger.warn(message)
    if (error) ctx.logger.warn(error)
  }

  let persistedTokenDaily = {}
  let pendingTokenDaily = {}
  const queuedTokenBatches = []
  const legacyDates = new Set()
  let costHistory = []
  let tokenWriteChain = Promise.resolve()
  let costWriteChain = Promise.resolve()
  let saveTimerDispose = null
  let liveBalanceCache = null
  let liveBalancePromise = null

  async function discoverLegacyFiles() {
    const paths = new Set([
      resolve(cwd, LEGACY_TOKEN_FILE), resolve(cwd, LEGACY_TOKEN_FILE_OLD),
      resolve(dshHome, LEGACY_TOKEN_FILE), resolve(dshHome, LEGACY_TOKEN_FILE_OLD)
    ])
    try {
      const registry = await readJson(join(dshHome, 'storages', 'workspace.json'))
      const workspaces = registry && registry.tables && registry.tables.workspaces
      if (workspaces && typeof workspaces === 'object') {
        for (const id in workspaces) {
          const workspacePath = workspaces[id] && workspaces[id].path
          if (typeof workspacePath === 'string' && workspacePath.trim()) {
            paths.add(resolve(workspacePath, LEGACY_TOKEN_FILE))
            paths.add(resolve(workspacePath, LEGACY_TOKEN_FILE_OLD))
          }
        }
      }
    } catch (e) {}
    return Array.from(paths)
  }

  function setPersistedTokenState(state) {
    persistedTokenDaily = cloneTokenDaily(state.daily)
    legacyDates.clear()
    for (const value of state.legacyDates) legacyDates.add(value)
  }
  function currentTokenDaily() {
    const result = cloneTokenDaily(persistedTokenDaily)
    for (const batch of queuedTokenBatches) addTokenDelta(result, batch)
    addTokenDelta(result, pendingTokenDaily)
    return result
  }

  async function loadTokenState() {
    await withFileLock(tokenTarget, async function () {
      const state = emptyTokenState()
      const stable = parseTokenPayload(await readJson(tokenTarget))
      let changed = false
      if (stable) {
        mergeTokenPayload(state, stable)
        if (stable.version !== TOKEN_SCHEMA_VERSION) changed = true
      }
      const legacyFiles = await discoverLegacyFiles()
      for (const filename of legacyFiles) {
        const parsed = parseTokenPayload(await readJson(filename))
        if (parsed && mergeTokenPayload(state, parsed) > 0) changed = true
      }
      if (changed || (!stable && Object.keys(state.daily).length > 0)) await atomicWriteJson(tokenTarget, tokenPayload(state))
      setPersistedTokenState(state)
    })
  }

  function queueTokenFlush() {
    const batch = pendingTokenDaily
    pendingTokenDaily = {}
    const hasBatch = Object.keys(batch).length > 0
    if (hasBatch) queuedTokenBatches.push(batch)
    tokenWriteChain = tokenWriteChain.then(async function () {
      try {
        await withFileLock(tokenTarget, async function () {
          const state = emptyTokenState()
          const parsed = parseTokenPayload(await readJson(tokenTarget))
          if (parsed) mergeTokenPayload(state, parsed)
          else {
            state.daily = cloneTokenDaily(persistedTokenDaily)
            for (const value of legacyDates) state.legacyDates.add(value)
          }
          for (const value of legacyDates) state.legacyDates.add(value)
          if (hasBatch) addTokenDelta(state.daily, batch)
          if (hasBatch || !parsed) await atomicWriteJson(tokenTarget, tokenPayload(state))
          setPersistedTokenState(state)
        })
      } catch (error) {
        if (hasBatch) addTokenDelta(pendingTokenDaily, batch)
        logWarning('deepseek-balance-dashboard: Token 全局写入失败', error)
      } finally {
        if (hasBatch) {
          const index = queuedTokenBatches.indexOf(batch)
          if (index >= 0) queuedTokenBatches.splice(index, 1)
        }
      }
    })
    return tokenWriteChain
  }

  function scheduleTokenSave() {
    if (saveTimerDispose) return
    saveTimerDispose = ctx.timeout(function () {
      saveTimerDispose = null
      return queueTokenFlush()
    }, 3000)
  }
  function recordUsage(usage) {
    try {
      const input = num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)
      const output = num(usage.outputTokens)
      const total = input + output
      if (total <= 0) return
      const key = dayKey(Date.now())
      const entry = pendingTokenDaily[key] || (pendingTokenDaily[key] = { input: 0, output: 0, total: 0 })
      entry.input += input
      entry.output += output
      entry.total += total
      scheduleTokenSave()
    } catch (e) {}
  }

  async function loadCostState() {
    await withFileLock(costTarget, async function () { costHistory = parseCostPayload(await readJson(costTarget)) })
  }
  function mergeCostHistory(snapshots) {
    const normalized = snapshots.map(normalizeSnapshot).filter(Boolean)
    if (normalized.length === 0) return Promise.resolve(0)
    let imported = 0
    costWriteChain = costWriteChain.then(async function () {
      try {
        await withFileLock(costTarget, async function () {
          const disk = parseCostPayload(await readJson(costTarget))
          const before = new Set(disk.map(snapshotKey))
          const merged = mergeSnapshots(disk, normalized)
          imported = merged.reduce(function (count, item) { return count + (before.has(snapshotKey(item)) ? 0 : 1) }, 0)
          if (imported > 0 || disk.length !== merged.length) await atomicWriteJson(costTarget, costPayload(merged))
          costHistory = merged
        })
      } catch (error) {
        logWarning('deepseek-balance-dashboard: 费用历史全局写入失败', error)
      }
    })
    return costWriteChain.then(function () { return imported })
  }

  const loadPromise = Promise.all([loadTokenState(), loadCostState()]).catch(function (error) {
    logWarning('deepseek-balance-dashboard: 全局数据加载失败', error)
  })

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

  async function buildDashboardResult(snapshot, meta) {
    await queueTokenFlush()
    return {
      ok: true,
      available: meta.available !== false,
      currency: snapshot.currency,
      total: snapshot.total,
      granted: snapshot.granted,
      topped: snapshot.topped,
      keySource: meta.keySource || '',
      cached: meta.cached === true,
      snapshotAt: snapshot.t,
      schemaVersion: API_SCHEMA_VERSION,
      tokenDaily: currentTokenDaily(),
      tokenLegacyDates: Array.from(legacyDates).sort(),
      costDaily: computeCostDaily(costHistory)
    }
  }

  async function fetchCachedBalance() {
    await loadPromise
    const snapshot = costHistory.length ? costHistory[costHistory.length - 1] : null
    if (!snapshot) return { ok: false, cacheMiss: true, error: '暂无余额缓存' }
    return buildDashboardResult(snapshot, { available: true, keySource: 'cache', cached: true })
  }

  async function performLiveBalance() {
    const credentials = svc('credentials')
    if (!credentials) return { ok: false, error: '凭据服务不可用' }
    const hit = await credentials.resolve(ENV_REF)
    if (!hit || typeof hit.value !== 'string' || hit.value === '') return { ok: false, error: '未找到 DeepSeek API Key（凭据 ' + ENV_REF + ' 未配置）' }
    const curlPath = await resolveCurl()
    if (curlPath === null) return { ok: false, error: '未找到 curl 可执行文件' }
    const subprocess = svc('subprocess')
    if (!subprocess) return { ok: false, error: '子进程服务不可用' }
    const handle = subprocess.spawn({
      argv: [curlPath, '-sS', '--max-time', '20', '-H', 'Authorization: Bearer ' + hit.value, BALANCE_URL],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: 5000
    })
    const outcome = await handle.done
    const stdoutText = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
    const stderrText = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
    if (outcome.exitCode !== 0) {
      const detail = (stderrText || stdoutText || '').trim().slice(0, 300)
      return { ok: false, error: '请求失败 (exit ' + outcome.exitCode + ')' + (detail ? ': ' + detail : '') }
    }
    let parsed = null
    try { parsed = JSON.parse(stdoutText) } catch (e) { return { ok: false, error: '无法解析 DeepSeek 返回: ' + (stdoutText || '').trim().slice(0, 300) } }
    if (!parsed || !Array.isArray(parsed.balance_infos) || parsed.balance_infos.length === 0) return { ok: false, error: '响应缺少余额数据（Key 可能无效）: ' + (stdoutText || '').trim().slice(0, 300) }

    const info = parsed.balance_infos[0] || {}
    const snapshot = {
      t: Date.now(), total: num(info.total_balance), granted: num(info.granted_balance),
      topped: num(info.topped_up_balance), currency: typeof info.currency === 'string' ? info.currency : ''
    }
    await mergeCostHistory([snapshot])
    liveBalanceCache = {
      at: Date.now(), snapshot,
      available: parsed.is_available === true,
      keySource: typeof hit.source === 'string' ? hit.source : ''
    }
    return buildDashboardResult(snapshot, { available: liveBalanceCache.available, keySource: liveBalanceCache.keySource, cached: false })
  }

  async function fetchLiveBalance(force) {
    await loadPromise
    if (!force && liveBalanceCache && Date.now() - liveBalanceCache.at < BALANCE_CACHE_MS) {
      return buildDashboardResult(liveBalanceCache.snapshot, {
        available: liveBalanceCache.available, keySource: liveBalanceCache.keySource, cached: true
      })
    }
    // 多标签页、mount 与 connection/reset 同时触发时共享一次官方请求。
    if (liveBalancePromise) return liveBalancePromise
    liveBalancePromise = performLiveBalance()
    try { return await liveBalancePromise } finally { liveBalancePromise = null }
  }

  async function handleHistoryImport(req, res) {
    if (req.method && req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'POST' })
      res.end(JSON.stringify({ ok: false, error: '仅支持 POST' }))
      return
    }
    const headers = req.headers || {}
    const contentType = typeof headers['content-type'] === 'string' ? headers['content-type'].toLowerCase() : ''
    if (!contentType.startsWith('application/json')) {
      res.writeHead(415, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: '仅接受 application/json' }))
      return
    }
    const origin = typeof headers.origin === 'string' ? headers.origin : ''
    const host = typeof headers.host === 'string' ? headers.host : ''
    if (origin) {
      let sameOrigin = false
      try { sameOrigin = new URL(origin).host === host } catch (e) {}
      if (!sameOrigin) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: '拒绝跨源历史导入' }))
        return
      }
    }
    try {
      await loadPromise
      const body = await readJsonBody(req, BODY_MAX)
      const history = body && Array.isArray(body.history) ? body.history.slice(-2000) : []
      const imported = await mergeCostHistory(history)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, schemaVersion: API_SCHEMA_VERSION, imported, costDaily: computeCostDaily(costHistory) }))
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) }))
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/deepseek-balance',
    handler: async (req, res) => {
      try {
        const requestUrl = new URL((req && req.url) || '/api/deepseek-balance', 'http://127.0.0.1')
        const cachedOnly = requestUrl.searchParams.get('cached') === '1'
        const force = requestUrl.searchParams.get('force') === '1'
        const result = cachedOnly ? await fetchCachedBalance() : await fetchLiveBalance(force)
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) }))
      }
    }
  }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/deepseek-balance/history', handler: handleHistoryImport }))

  // stop/重载前取消防抖并等待增量与费用写链完成，避免正常退出丢失最后一批数据。
  ctx.effect(() => async function () {
    if (saveTimerDispose) {
      saveTimerDispose()
      saveTimerDispose = null
    }
    await loadPromise
    await queueTokenFlush()
    await tokenWriteChain
    await costWriteChain
  })
}
