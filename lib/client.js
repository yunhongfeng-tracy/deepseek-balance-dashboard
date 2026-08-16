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
      if (tokens <= 0) return 'var(--dsw-alias-bg-layer-2)'
      if (maxTokens <= 0) return '#216e39'
      var r = tokens / maxTokens
      if (r <= 0.25) return '#9be9a8'
      if (r <= 0.5) return '#40c463'
      if (r <= 0.75) return '#30a14e'
      return '#216e39'
    }

    function buildHeatmap(tokenDaily, moneyMap, monthsBack) {
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
          week.push({ key: key, dow: r, tokens: tokens, cost: cost })
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
      var WD = ['一', '二', '三', '四', '五', '六', '日']
      var API_URL = '/api/deepseek-balance'

      // 样式注入（卸载时移除）
      var styleEl = document.createElement('style')
      styleEl.textContent = '.dsb-page{display:flex;flex-direction:column;gap:20px;width:100%;color:var(--dsw-alias-label-primary)}\n' +
        '.dsb-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}\n' +
        '.dsb-page-title{font-size:16px;font-weight:700}\n' +
        '.dsb-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;margin-top:2px}\n' +
        '.dsb-btn{padding:8px 14px;border:none;border-radius:8px;background:var(--dsw-alias-brand-primary);color:#fff;cursor:pointer;font-size:12px;font-weight:600;white-space:nowrap;flex-shrink:0}\n' +
        '.dsb-btn:disabled{opacity:.55;cursor:default}\n' +
        '.dsb-error{color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-word}\n' +
        '.dsb-section-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0 0 10px}\n' +
        '.dsb-balance{display:grid;grid-template-columns:1fr 1fr;gap:10px}\n' +
        '.dsb-stats-row{display:grid;grid-template-columns:repeat(4, 1fr);gap:10px}\n' +
        '.dsb-stat{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px}\n' +
        '.dsb-stat.big{grid-column:1/-1;background:var(--dsw-alias-bg-base)}\n' +
        '.dsb-stat-label{color:var(--dsw-alias-label-secondary);font-size:11px}\n' +
        '.dsb-stat-value{font-size:24px;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums}\n' +
        '.dsb-stat-value.small{font-size:16px}\n' +
        '.dsb-stat-sub{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:3px}\n' +
        '.dsb-cell{border-radius:3px;cursor:default}\n' +
        '.dsb-legend{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:12px}\n' +
        '.dsb-legend-dot{width:12px;height:12px;border-radius:3px;display:inline-block}\n' +
        '.dsb-scroll{max-width:100%;overflow-x:auto}\n' +
        '.dsb-tooltip{position:fixed;z-index:99999;background:#000;color:#fff;font-size:12px;line-height:1;padding:7px 11px;border-radius:6px;pointer-events:none;white-space:nowrap;box-shadow:0 6px 16px rgba(0,0,0,.35)}'
      document.head.appendChild(styleEl)
      ctx.effect(function () { return function () { styleEl.remove() } })

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
        var historyState = React.useState(loadHistory)
        var history = historyState[0]
        var setHistory = historyState[1]
        var tokenDailyState = React.useState({})
        var tokenDaily = tokenDailyState[0]
        var setTokenDaily = tokenDailyState[1]
        var hoverState = React.useState(null)
        var hover = hoverState[0]
        var setHover = hoverState[1]

        function fetchBalance() {
          setLoading(true)
          setError('')
          fetch(API_URL).then(function (resp) { return resp.json() }).then(function (res) {
            setLoading(false)
            if (res && res.ok) {
              setBalance(res)
              setTokenDaily(res.tokenDaily || {})
              setHistory(function (prev) {
                var next = prev.concat([{ t: Date.now(), total: res.total, granted: res.granted, topped: res.topped, currency: res.currency }])
                persistHistory(next)
                return next
              })
            } else {
              setError((res && res.error) ? res.error : '查询失败')
            }
          }).catch(function (e) {
            setLoading(false)
            setError(e && e.message ? e.message : String(e))
          })
        }

        React.useEffect(function () {
          fetchBalance()
          var dispose = ctx.interval(fetchBalance, AUTO_MS)
          return dispose
        }, [])

        var days = computeDaily(history)
        var currency = balance ? balance.currency : (days.length ? days[0].currency : '')
        var moneyMap = {}
        for (var i = 0; i < days.length; i++) moneyMap[days[i].day] = { spend: days[i].spend }

        var heat = buildHeatmap(tokenDaily, moneyMap, 6)
        var N = heat.weeks.length
        var CELL = 15
        var GAP = 5
        var gridW = N * CELL + (N - 1) * GAP

        var cells = []
        for (var w = 0; w < N; w++) {
          for (var r = 0; r < heat.weeks[w].length; r++) {
            var c = heat.weeks[w][r]
            cells.push(React.createElement('div', {
              key: c.key,
              className: 'dsb-cell',
              title: c.key + '（周' + WD[c.dow] + '）· Token ' + fmtTokens(c.tokens) + ' · 费用 ' + money(c.cost, currency),
              style: {
                gridColumn: w + 1,
                gridRow: r + 1,
                width: CELL,
                height: CELL,
                boxSizing: 'border-box',
                border: '1px solid var(--dsw-alias-border-l1)',
                background: heatColor(c.tokens, heat.maxTokens)
              },
              onMouseEnter: function (e) { setHover({ key: c.key, dow: c.dow, tokens: c.tokens, cost: c.cost, x: e.clientX, y: e.clientY }) },
              onMouseMove: function (e) { setHover(function (prev) { return prev ? { key: prev.key, dow: prev.dow, tokens: prev.tokens, cost: prev.cost, x: e.clientX, y: e.clientY } : prev }) },
              onMouseLeave: function () { setHover(null) }
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

        var tooltipText = hover ? (fmtDate(hover.key) + ' · Token ' + fmtTokens(hover.tokens) + ' · ' + money(hover.cost, currency)) : ''
        var legendColors = ['var(--dsw-alias-bg-layer-2)', '#9be9a8', '#40c463', '#30a14e', '#216e39']

        return React.createElement('div', { className: 'dsb-page' },
          React.createElement('div', { className: 'dsb-page-head' },
            React.createElement('div', null,
              React.createElement('div', { className: 'dsb-page-title' }, 'DeepSeek API 余额与用量'),
              React.createElement('div', { className: 'dsb-hint' },
                balance ? '密钥来源：' + (balance.keySource || 'Harness 凭据') + ' · 每 5 分钟自动刷新'
                  : (loading ? '正在读取凭据并查询余额…' : '密钥从 Harness 凭据自动读取，无需手动输入')
              )
            ),
            React.createElement('button', { className: 'dsb-btn', disabled: loading, onClick: fetchBalance }, loading ? '查询中…' : '↻ 刷新')
          ),
          error ? React.createElement('div', { className: 'dsb-error' }, error) : null,
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
              peakDay ? React.createElement('div', { className: 'dsb-stat-sub' }, fmtDateShort(peakDay)) : null
            ),
            React.createElement('div', { className: 'dsb-stat' },
              React.createElement('div', { className: 'dsb-stat-label' }, '峰值费用'),
              React.createElement('div', { className: 'dsb-stat-value small' }, money(peakMoney, currency)),
              peakDay ? React.createElement('div', { className: 'dsb-stat-sub' }, fmtDateShort(peakDay)) : null
            ),
            React.createElement('div', { className: 'dsb-stat' },
              React.createElement('div', { className: 'dsb-stat-label' }, '今日 Token'),
              React.createElement('div', { className: 'dsb-stat-value small' }, fmtTokens(todayTokens))
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
                  return React.createElement('span', { key: 'lg' + i, className: 'dsb-legend-dot', style: { background: cc, border: '1px solid var(--dsw-alias-border-l1)' } })
                }),
                React.createElement('span', null, '多')
              )
            )
          ),
          hover ? React.createElement('div', { className: 'dsb-tooltip', style: { left: hover.x + 14, top: hover.y - 36 } }, tooltipText) : null
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
