// DeepSeek 余额与 token 用量看板 —— 客户端半（浏览器）
//
// 注册为设置面板中与「通用/模型/插件」并列的一页；数据通过
// `fetch('/api/deepseek-balance')` 从主机半的 HTTP 路由获取。

window.__ModuleLoader__.load({
  id: 'deepseek-balance-dashboard',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    function pad(n) { return n < 10 ? '0' + n : '' + n }
    function dayKeyOf(ts) {
      var d = new Date(ts)
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    }
    function money(n, currency) {
      var sym = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : (currency ? currency + ' ' : '')
      return sym + Number(n).toFixed(2)
    }
    function sourceLabel(src) {
      if (src === 'env') return '环境变量'
      if (src === 'file') return '凭据文件'
      if (src === 'project-env') return '项目 .env'
      if (src === 'user-env') return '用户 .env'
      return 'Harness 凭据'
    }
    function fmtTokens(v) {
      if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M'
      if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
      return String(Math.round(v))
    }
    function monthName(d) { return (d.getMonth() + 1) + '月' }
    function fmtDate(key) {
      return (parseInt(key.slice(5, 7), 10)) + '月' + (parseInt(key.slice(8, 10), 10)) + '日'
    }
    function fmtDateShort(key) {
      return (parseInt(key.slice(5, 7), 10)) + '/' + (parseInt(key.slice(8, 10), 10))
    }
    function heatColor(tokens, maxTokens) {
      if (tokens <= 0) return ''
      if (maxTokens <= 0) return '#216e39'
      var r = tokens / maxTokens
      if (r <= 0.25) return '#9be9a8'
      if (r <= 0.5) return '#40c463'
      if (r <= 0.75) return '#30a14e'
      return '#216e39'
    }

    function buildHeatmap(tokenDaily, moneyMap, legacyMap, monthsBack) {
      var today = new Date()
      today.setHours(0, 0, 0, 0)
      var start = new Date(today)
      start.setMonth(start.getMonth() - monthsBack)
      start.setHours(0, 0, 0, 0)
      var dow = start.getDay()
      var backToMonday = dow === 0 ? 6 : (dow - 1)
      start.setDate(start.getDate() - backToMonday)

      var weeks = []
      var cur = new Date(start)
      while (cur.getTime() <= today.getTime()) {
        var week = []
        for (var r = 0; r < 7; r++) {
          if (cur.getTime() > today.getTime()) break
          var key = dayKeyOf(cur.getTime())
          var tokens = (tokenDaily[key] && tokenDaily[key].total) || 0
          var cost = (moneyMap[key] && moneyMap[key].spend) || 0
          week.push({ key: key, dow: r, tokens: tokens, cost: cost, legacy: legacyMap[key] === true })
          cur.setDate(cur.getDate() + 1)
        }
        if (week.length > 0) weeks.push(week)
      }

      var maxTokens = 0
      for (var w = 0; w < weeks.length; w++) for (var r2 = 0; r2 < weeks[w].length; r2++) if (weeks[w][r2].tokens > maxTokens) maxTokens = weeks[w][r2].tokens

      var monthLabels = []
      for (var col = 0; col < weeks.length; col++) {
        var hit = null
        for (var r3 = 0; r3 < weeks[col].length; r3++) {
          var dd = new Date(start.getTime() + ((col * 7) + r3) * 86400000)
          if (dd.getDate() === 1) { hit = dd; break }
        }
        if (hit) monthLabels.push({ col: col, label: monthName(hit) })
        else if (col === 0) monthLabels.push({ col: 0, label: monthName(new Date(start.getTime())) })
      }

      return { weeks: weeks, monthLabels: monthLabels, maxTokens: maxTokens }
    }

    exports.name = 'deepseek-balance-dashboard'
    exports.inject = ['slots', 'timer']

    exports.apply = function (ctx) {
      var LS_KEY = 'dsh:deepseek-balance:history:v1'
      var AUTO_MS = 5 * 60 * 1000
      var SCHEMA_VERSION = 4
      var WD = ['一', '二', '三', '四', '五', '六', '日']
      var API_URL = '/api/deepseek-balance'
      var HISTORY_API_URL = '/api/deepseek-balance/history'
      var REFRESH_EVENT = 'dsh:deepseek-balance:refresh'

      // connection Context 与 React 组件可能不同步卸载。新 Context 收到重连事件后，
      // 通过稳定的 window 事件通知仍存活的 Dashboard 组件立即刷新。
      // 使用 ctx.effect 包裹 ctx.on，确保插件卸载时自动清理监听器，不泄漏。
      ctx.effect(function () {
        var handler = function () { window.dispatchEvent(new Event(REFRESH_EVENT)) }
        var dispose = ctx.on('connection/reset', handler)
        // 首次加载也触发一次刷新，确保连接建立后数据最新
        handler()
        return dispose
      })

      // 与 DSH 内置客户端模块保持一致：使用稳定标记幂等注入 CSS，并让样式跨
      // connection/reset 保留。旧实现会在 Host 重启时移除 style，但设置页组件仍在，
      // 造成页面退化成无样式的原始文本。
      var STYLE_KEY = 'deepseek-balance-dashboard/dashboard'
      var STYLE_SELECTOR = 'style[data-plugin-css="' + STYLE_KEY + '"]'
      // 历史版本曾注入无身份标记的样式标签；统一按插件身份清理陈旧标签，再保留一个。
      var staleStyles = document.querySelectorAll(STYLE_SELECTOR)
      for (var si = 0; si < staleStyles.length; si++) staleStyles[si].remove()
      var styleEl = document.createElement('style')
      styleEl.dataset.plugin = 'deepseek-balance-dashboard'
      styleEl.dataset.pluginCss = STYLE_KEY
      styleEl.textContent = '.dsb-page{display:flex;flex-direction:column;gap:20px;width:100%;color:var(--dsw-alias-label-primary)}\n' +
          '.dsb-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}\n' +
          '.dsb-page-title{font-size:16px;font-weight:700}\n' +
          '.dsb-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;margin-top:2px}\n' +
          '.dsb-btn{padding:8px 14px;border:none;border-radius:8px;background:var(--dsw-alias-brand-primary);color:#fff;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;flex-shrink:0}\n' +
          '.dsb-btn:disabled{opacity:.55;cursor:default}\n' +
          '.dsb-error{color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-word}\n' +
          '.dsb-stale{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:1.5;word-break:break-word}\n' +
          '.dsb-section-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0 0 10px}\n' +
          '.dsb-balance{display:grid;grid-template-columns:1fr 1fr;gap:10px}\n' +
          '.dsb-stats-row{display:grid;grid-template-columns:repeat(4, 1fr);gap:10px}\n' +
          '.dsb-stat{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px}\n' +
          '.dsb-stat.big{grid-column:1/-1;background:var(--dsw-alias-bg-base)}\n' +
          '.dsb-stat-label{color:var(--dsw-alias-label-secondary);font-size:11px}\n' +
          '.dsb-stat-value{font-size:24px;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums}\n' +
          '.dsb-stat-value.small{font-size:16px}\n' +
          '.dsb-stat-sub{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:3px}\n' +
          '.dsb-cell{border:1px solid var(--dsw-alias-border-l1);border-radius:3px;cursor:default}\n' +
          '.dsb-cell.empty{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-alias-border-l2)}\n' +
          '.dsb-cell.legacy{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-warn-primary)}\n' +
          '.dsb-cell:hover,.dsb-cell:focus-visible{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}\n' +
          '.dsb-legend{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:12px}\n' +
          '.dsb-legend-dot{width:12px;height:12px;border-radius:3px;display:inline-block;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1)}\n' +
          '.dsb-legend-dot.legacy{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-warn-primary)}\n' +
          '.dsb-scroll{max-width:100%;overflow-x:auto}\n' +
          '.dsb-tooltip{position:fixed;z-index:99999;background:#000;color:#fff;font-size:12px;line-height:1;padding:7px 11px;border-radius:6px;pointer-events:none;white-space:nowrap;box-shadow:0 6px 16px rgba(0,0,0,.35)}'
      document.head.appendChild(styleEl)

      function loadHistory() {
        try {
          if (typeof localStorage === 'undefined') return []
          var raw = localStorage.getItem(LS_KEY)
          if (!raw) return []
          var arr = JSON.parse(raw)
          if (!Array.isArray(arr)) return []
          return arr.filter(function (s) { return s && typeof s.t === 'number' && typeof s.total === 'number' })
        } catch (e) { return [] }
      }

      function persistHistory(arr) {
        try {
          if (typeof localStorage === 'undefined') return
          localStorage.setItem(LS_KEY, JSON.stringify(arr.slice(-2000)))
        } catch (e) {}
      }

      function computeDaily(history) {
        var sorted = history.slice().sort(function (a, b) { return a.t - b.t })
        var byDay = {}
        for (var i = 0; i < sorted.length; i++) {
          var s = sorted[i]
          var dk = dayKeyOf(s.t)
          if (!byDay[dk]) byDay[dk] = { day: dk, spend: 0, currency: s.currency || '' }
          if (s.currency) byDay[dk].currency = s.currency
          if (i > 0) {
            var prev = sorted[i - 1]
            if (dayKeyOf(prev.t) === dk) {
              var delta = prev.total - s.total
              if (delta > 0) byDay[dk].spend += delta
            }
          }
        }
        var list = []
        for (var k in byDay) list.push(byDay[k])
        list.sort(function (a, b) { return a.day < b.day ? 1 : -1 })
        return list.slice(0, 7)
      }

      function Dashboard() {
        var loadingState = React.useState(false)
        var loading = loadingState[0]
        var setLoading = loadingState[1]
        var balanceState = React.useState(null)
        var balance = balanceState[0]
        var setBalance = balanceState[1]
        var errorState = React.useState('')
        var error = errorState[0]
        var setError = errorState[1]
        var staleState = React.useState(false)
        var stale = staleState[0]
        var setStale = staleState[1]
        var refreshWarningState = React.useState('')
        var refreshWarning = refreshWarningState[0]
        var setRefreshWarning = refreshWarningState[1]
        var historyState = React.useState(loadHistory)
        var history = historyState[0]
        var setHistory = historyState[1]
        var historyRef = React.useRef(history)
        var importStartedRef = React.useRef(false)
        var hasGoodDataRef = React.useRef(false)
        var requestIdRef = React.useRef(0)
        var tokenDailyState = React.useState({})
        var tokenDaily = tokenDailyState[0]
        var setTokenDaily = tokenDailyState[1]
        var costDailyState = React.useState({})
        var costDaily = costDailyState[0]
        var setCostDaily = costDailyState[1]
        var legacyDatesState = React.useState({})
        var legacyMap = legacyDatesState[0]
        var setLegacyMap = legacyDatesState[1]
        var hoverState = React.useState(null)
        var hover = hoverState[0]
        var setHover = hoverState[1]

        function showFetchFailure(message) {
          if (hasGoodDataRef.current) {
            setRefreshWarning('刷新失败，当前仍显示上次成功数据：' + message)
            setError('')
          } else {
            setError(message)
          }
        }

        function importLocalHistoryOnce() {
          var localHistory = historyRef.current
          if (importStartedRef.current || !localHistory || localHistory.length === 0) return
          importStartedRef.current = true
          fetch(HISTORY_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ history: localHistory.slice(-2000) })
          }).then(function (resp) { return resp.json() }).then(function (res) {
            if (res && res.ok) {
              setCostDaily(res.costDaily || {})
            } else {
              importStartedRef.current = false
              setRefreshWarning('本地费用历史导入失败；当前继续显示 Host 已保存的数据，稍后会重试。')
            }
          }).catch(function () {
            importStartedRef.current = false
            setRefreshWarning('本地费用历史导入失败；当前继续显示 Host 已保存的数据，稍后会重试。')
          })
        }

        function fetchBalance() {
          var requestId = ++requestIdRef.current
          setLoading(true)
          setError('')
          fetch(API_URL).then(function (resp) { return resp.json() }).then(function (res) {
            if (requestId !== requestIdRef.current) return
            setLoading(false)
            if (res && res.ok) {
              hasGoodDataRef.current = true
              setBalance(res)
              setStale(res.schemaVersion !== SCHEMA_VERSION)
              setRefreshWarning('')
              setTokenDaily(res.tokenDaily || {})
              setCostDaily(res.costDaily || {})
              setHover(null)
              var nextLegacyMap = {}
              var legacyDates = Array.isArray(res.tokenLegacyDates) ? res.tokenLegacyDates : []
              for (var li = 0; li < legacyDates.length; li++) nextLegacyMap[legacyDates[li]] = true
              setLegacyMap(nextLegacyMap)
              if (res.schemaVersion === SCHEMA_VERSION) {
                importLocalHistoryOnce()
              } else {
                setHistory(function (prev) {
                  var next = prev.concat([{ t: Date.now(), total: res.total, granted: res.granted, topped: res.topped, currency: res.currency }])
                  historyRef.current = next
                  persistHistory(next)
                  return next
                })
              }
            } else {
              showFetchFailure((res && res.error) ? res.error : '查询失败')
            }
          }).catch(function (e) {
            if (requestId !== requestIdRef.current) return
            setLoading(false)
            showFetchFailure(e && e.message ? e.message : String(e))
          })
        }

        React.useEffect(function () {
          fetchBalance()
          var disposeInterval = ctx.interval(fetchBalance, AUTO_MS)
          window.addEventListener(REFRESH_EVENT, fetchBalance)
          return function () {
            window.removeEventListener(REFRESH_EVENT, fetchBalance)
            if (typeof disposeInterval === 'function') disposeInterval()
          }
        }, [])

        React.useEffect(function () {
          function clearHover() { setHover(null) }
          function clearOnPointerDown(e) {
            var target = e && e.target
            if (target && typeof target.closest === 'function' && target.closest('.dsb-cell')) return
            clearHover()
          }
          function clearOnKeyDown(e) { if (e && e.key === 'Escape') clearHover() }
          function clearOnVisibility() { if (document.visibilityState !== 'visible') clearHover() }
          document.addEventListener('pointerdown', clearOnPointerDown, true)
          document.addEventListener('pointercancel', clearHover, true)
          document.addEventListener('keydown', clearOnKeyDown, true)
          document.addEventListener('visibilitychange', clearOnVisibility)
          document.documentElement.addEventListener('mouseleave', clearHover)
          window.addEventListener('blur', clearHover)
          window.addEventListener('scroll', clearHover, true)
          return function () {
            document.removeEventListener('pointerdown', clearOnPointerDown, true)
            document.removeEventListener('pointercancel', clearHover, true)
            document.removeEventListener('keydown', clearOnKeyDown, true)
            document.removeEventListener('visibilitychange', clearOnVisibility)
            document.documentElement.removeEventListener('mouseleave', clearHover)
            window.removeEventListener('blur', clearHover)
            window.removeEventListener('scroll', clearHover, true)
          }
        }, [])

        var days = computeDaily(history)
        var currency = balance ? balance.currency : (days.length ? days[0].currency : '')
        var moneyMap = {}
        if (balance && balance.schemaVersion === SCHEMA_VERSION) {
          for (var costKey in costDaily) moneyMap[costKey] = { spend: (costDaily[costKey] && costDaily[costKey].spend) || 0 }
        } else {
          for (var i = 0; i < days.length; i++) moneyMap[days[i].day] = { spend: days[i].spend }
        }

        var heat = buildHeatmap(tokenDaily, moneyMap, legacyMap, 6)
        var N = heat.weeks.length
        var CELL = 15
        var GAP = 5
        var gridW = N * CELL + (N - 1) * GAP

        var cells = []
        for (var w = 0; w < N; w++) {
          for (var r = 0; r < heat.weeks[w].length; r++) {
            // 必须使用块级绑定；var 会让所有事件处理器引用循环结束后的最后一天。
            const c = heat.weeks[w][r]
            cells.push(React.createElement('div', {
              key: c.key,
              className: 'dsb-cell' + (c.tokens <= 0 ? ' empty' : '') + (c.legacy ? ' legacy' : ''),
              role: 'gridcell',
              tabIndex: (c.tokens > 0 || c.cost > 0) ? 0 : -1,
              'aria-label': c.key + ' 周' + WD[c.dow] + '，Token ' + fmtTokens(c.tokens) + '，费用 ' + money(c.cost, currency) + (c.legacy ? '，历史估算口径' : ''),
              style: {
                gridColumn: w + 1,
                gridRow: r + 1,
                width: CELL,
                height: CELL,
                boxSizing: 'border-box',
                background: heatColor(c.tokens, heat.maxTokens)
              },
              onMouseEnter: function (e) { setHover({ key: c.key, dow: c.dow, tokens: c.tokens, cost: c.cost, legacy: c.legacy, x: e.clientX, y: e.clientY }) },
              onMouseMove: function (e) { setHover(function (prev) { return prev ? { key: prev.key, dow: prev.dow, tokens: prev.tokens, cost: prev.cost, legacy: prev.legacy, x: e.clientX, y: e.clientY } : prev }) },
              onMouseLeave: function () { setHover(null) },
              onFocus: function (e) { var rect = e.currentTarget.getBoundingClientRect(); setHover({ key: c.key, dow: c.dow, tokens: c.tokens, cost: c.cost, legacy: c.legacy, x: rect.left + rect.width / 2, y: rect.top }) },
              onBlur: function () { setHover(null) },
              onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setHover({ key: c.key, dow: c.dow, tokens: c.tokens, cost: c.cost, legacy: c.legacy, x: 40, y: 40 }) } else if (e.key === 'Escape') { setHover(null) } }
            }))
          }
        }

        var todayKey = dayKeyOf(Date.now())
        var totalTokens = 0
        var peakTokens = 0
        var peakDay = null
        for (var k in tokenDaily) {
          var t = tokenDaily[k] && tokenDaily[k].total ? tokenDaily[k].total : 0
          totalTokens += t
          if (t > peakTokens) { peakTokens = t; peakDay = k }
        }
        var peakMoney = (peakDay && moneyMap[peakDay]) ? moneyMap[peakDay].spend : 0
        var todayTokens = (tokenDaily[todayKey] && tokenDaily[todayKey].total) || 0
        var legacyCount = Object.keys(legacyMap).length

        var tooltipText = hover
          ? (fmtDate(hover.key) + ' · Token ' + fmtTokens(hover.tokens) + ' · ' + money(hover.cost, currency) + (hover.legacy ? ' · 历史估算口径' : ''))
          : ''
        var legendColors = ['var(--dsw-alias-bg-module-platform)', '#9be9a8', '#40c463', '#30a14e', '#216e39']

        return React.createElement('div', { className: 'dsb-page' },
          React.createElement('div', { className: 'dsb-page-head' },
            React.createElement('div', null,
              React.createElement('div', { className: 'dsb-page-title' }, 'DeepSeek API 余额与用量'),
              React.createElement('div', { className: 'dsb-hint' },
                balance
                  ? ('密钥来源：' + sourceLabel(balance.keySource) + ' · 每 5 分钟自动刷新' + (legacyCount ? ' · 含 ' + legacyCount + ' 天历史估算记录' : ''))
                  : (loading ? '正在读取凭据并查询余额…' : '密钥从 Harness 凭据自动读取，无需手动输入')
              )
            ),
            React.createElement('button', { className: 'dsb-btn', disabled: loading, onClick: fetchBalance }, loading ? '查询中…' : '↻ 刷新')
          ),
          error ? React.createElement('div', { className: 'dsb-error' }, error) : null,
          refreshWarning ? React.createElement('div', { className: 'dsb-stale' }, refreshWarning) : null,
          stale ? React.createElement('div', { className: 'dsb-stale' },
            'Host 仍在运行历史版本插件（数据接口版本过低）。请重启 DSH 后按 Ctrl+F5 刷新，最新全局数据才会显示。'
          ) : null,
          balance ? React.createElement('div', null,
            React.createElement('div', { className: 'dsb-section-title' }, '余额'),
            React.createElement('div', { className: 'dsb-balance' },
              React.createElement('div', { className: 'dsb-stat big' },
                React.createElement('div', { className: 'dsb-stat-label' }, '总余额' + (balance.available === false ? '（不可用）' : '')),
                React.createElement('div', { className: 'dsb-stat-value' }, money(balance.total, balance.currency))
              ),
              React.createElement('div', { className: 'dsb-stat' },
                React.createElement('div', { className: 'dsb-stat-label' }, '充值余额'),
                React.createElement('div', { className: 'dsb-stat-value small' }, money(balance.topped, balance.currency))
              ),
              React.createElement('div', { className: 'dsb-stat' },
                React.createElement('div', { className: 'dsb-stat-label' }, '赠送余额'),
                React.createElement('div', { className: 'dsb-stat-value small' }, money(balance.granted, balance.currency))
              )
            )
          ) : null,
          React.createElement('div', { className: 'dsb-stats-row' },
            React.createElement('div', { className: 'dsb-stat' },
              React.createElement('div', { className: 'dsb-stat-label' }, '累计 Token'),
              React.createElement('div', { className: 'dsb-stat-value small' }, fmtTokens(totalTokens))
            ),
            React.createElement('div', { className: 'dsb-stat' },
              React.createElement('div', { className: 'dsb-stat-label' }, '峰值 Token'),
              React.createElement('div', { className: 'dsb-stat-value small' }, fmtTokens(peakTokens)),
              peakDay ? React.createElement('div', { className: 'dsb-stat-sub' }, fmtDateShort(peakDay) + (legacyMap[peakDay] ? ' · 历史估算' : '')) : null
            ),
            React.createElement('div', { className: 'dsb-stat' },
              React.createElement('div', { className: 'dsb-stat-label' }, '峰值费用'),
              React.createElement('div', { className: 'dsb-stat-value small' }, money(peakMoney, currency)),
              peakDay ? React.createElement('div', { className: 'dsb-stat-sub' }, fmtDateShort(peakDay) + (legacyMap[peakDay] ? ' · 历史估算' : '')) : null
            ),
            React.createElement('div', { className: 'dsb-stat' },
              React.createElement('div', { className: 'dsb-stat-label' }, '今日 Token'),
              React.createElement('div', { className: 'dsb-stat-value small' }, fmtTokens(todayTokens)),
              legacyMap[todayKey] ? React.createElement('div', { className: 'dsb-stat-sub' }, '历史估算口径') : null
            )
          ),
          React.createElement('div', null,
            React.createElement('div', { className: 'dsb-scroll' },
              React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: GAP, paddingTop: 18 } },
                  WD.map(function (wd, i) {
                    return React.createElement('span', { key: 'w' + i, style: { height: CELL, lineHeight: CELL + 'px', fontSize: 10, color: 'var(--dsw-alias-label-secondary)', textAlign: 'center' } }, wd)
                  })
                ),
                React.createElement('div', null,
                  React.createElement('div', { style: { position: 'relative', height: 18, width: gridW } },
                    heat.monthLabels.map(function (l) {
                      return React.createElement('span', { key: 'm' + l.col, style: { position: 'absolute', left: (l.col * (CELL + GAP)), top: 0, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } }, l.label)
                    })
                  ),
                  React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(' + N + ', ' + CELL + 'px)', gridTemplateRows: 'repeat(7, ' + CELL + 'px)', gap: GAP } }, cells)
                )
              ),
              React.createElement('div', { className: 'dsb-legend' },
                React.createElement('span', null, '少'),
                legendColors.map(function (cc, i) {
                  return React.createElement('span', { key: 'lg' + i, className: 'dsb-legend-dot', style: { background: cc } })
                }),
                React.createElement('span', null, '多'),
                legacyCount ? React.createElement('span', { className: 'dsb-legend-dot legacy', style: { background: 'transparent' } }) : null,
                legacyCount ? React.createElement('span', null, '历史估算口径') : null
              )
            )
          ),
          hover ? React.createElement('div', { className: 'dsb-tooltip', role: 'tooltip', style: { left: hover.x + 14, top: hover.y - 36 } }, tooltipText) : null
        )
      }

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'deepseek-balance', order: 17, label: 'DeepSeek 余额' },
          function () { return React.createElement(Dashboard) }
        )
      })
    }

    return module.exports
  }
})
