/* ===========================================================
   接口封装（移动端）
   基址解析：候选并行探测 /api/health（单次 2 秒超时），冷启动轮询重试直到内嵌服务就绪
   候选优先级：
     1) window.__API_BASE__（构建时注入 / 设置页手动指定）
     2) localStorage 上次探测成功且写入的基址
     3) http://10.0.2.2:34200   （安卓模拟器访问宿主的固定别名）
     4) http://127.0.0.1:34200  （真机/本机服务，需 adb reverse）
   探测策略（解决冷启动竞态）：
     - 每轮并行探测全部候选，任一可用立即锁定并缓存
     - 全部失败则间隔 600ms 重试，最长 18 秒（覆盖内嵌 node 启动耗时）
       期间调用方 await ready() 挂起，页面显示"正在连接本地服务"而不是错误页
     - 请求层遇到网络类异常（fetch 抛错 / 请求超时）自动作废旧基址、重新探测并重发一次
   音频播放与封面统一走 /api/proxy 转发，使用同一探测基址
   =========================================================== */
(function () {
  'use strict'

  var LS_KEY = 'lx.apiBase'
  var PROBE_PATH = '/api/health'

  /* v55（真机问题 5）：连接本地服务慢的根因是"单个探测等 3.5 秒、失败还要再等 600ms"，
     nodejs-mobile 服务端在真机上冷启动约 0.4~1.5 秒，这段时间内第一次探测必然超时，
     用户就会盯着"正在连接本地服务…"很久。
     改成短超时 + 密轮询：单次 1.6 秒，每 300 毫秒重试一次，服务一就绪立刻命中。 */
  var PROBE_TIMEOUT = 1600     /* 单次探测超时 */
  var PROBE_INTERVAL = 300     /* 轮询间隔 */
  var PROBE_WINDOW = 12000     /* 冷启动轮询总窗口 */
  var REQUEST_TIMEOUT = 20000  /* 业务请求超时（含远端音源解析） */
  var RETRY_WINDOW = 5000      /* 请求失败后重新探测的窗口，避免用户干等 */

  var FALLBACK_CANDIDATES = [
    'http://10.0.2.2:34200',
    'http://127.0.0.1:34200',
  ]

  /* resolvedBase === null 表示尚未解析出结果；'' 表示全部候选失败、退回同源 */
  var resolvedBase = null
  var readyPromise = null
  var lastTried = []      /* [{ base, reason }] 最近一轮探测明细 */
  var lastOkBase = null
  var lastFail = null     /* { path, base, kind: 'network'|'http', reason } */
  var status = { phase: 'idle', round: 0, elapsed: 0, window: PROBE_WINDOW }
  var listeners = []

  function normalize(v) {
    return String(v == null ? '' : v).trim().replace(/\/+$/, '')
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms) })
  }

  function loadBase() {
    try { return normalize(localStorage.getItem(LS_KEY) || '') } catch (e) { return '' }
  }

  function saveBase(v) {
    try {
      var t = normalize(v)
      if (t) localStorage.setItem(LS_KEY, t)
      else localStorage.removeItem(LS_KEY)
    } catch (e) {}
  }

  function injectedBase() {
    return (typeof window.__API_BASE__ === 'string') ? normalize(window.__API_BASE__) : ''
  }

  /** 按优先级构建候选列表（去重、保序） */
  function candidates() {
    var raw = [injectedBase(), loadBase()].filter(function (v) { return !!v }).concat(FALLBACK_CANDIDATES)
    var out = []
    for (var i = 0; i < raw.length; i++) {
      var v = normalize(raw[i])
      if (v && out.indexOf(v) === -1) out.push(v)
    }
    return out
  }

  /** 统一错误归因；prefix 用于区分"探测"与"请求" */
  function errReason(e, timeoutMs, prefix) {
    if (!e) return '未知错误'
    var t = timeoutMs || PROBE_TIMEOUT
    if (e && e.name === 'AbortError') {
      return (prefix || '') + '超时（' + (Math.round(t / 100) / 10) + ' 秒无响应）'
    }
    var msg = String((e && e.message) || e)
    if (/Failed to fetch|NetworkError|Load failed|Network request failed|fetch/i.test(msg)) {
      return '连接被拒绝或不可达'
    }
    return msg
  }

  /** 状态快照，供 UI 展示"正在连接本地服务（第 n 次探测 / 已 n 秒）" */
  function statusInfo() {
    return {
      phase: status.phase,
      round: status.round,
      elapsed: status.elapsed,
      window: status.window,
      base: resolvedBase || '',
      tried: lastTried.slice(),
      fail: lastFail ? { path: lastFail.path, base: lastFail.base, kind: lastFail.kind, reason: lastFail.reason } : null,
    }
  }

  function notify() {
    if (!listeners.length) return
    var st = statusInfo()
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](st) } catch (e) {}
    }
  }

  function onStatus(fn) {
    if (typeof fn !== 'function') return function () {}
    listeners.push(fn)
    try { fn(statusInfo()) } catch (e) {}
    return function () {
      var i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    }
  }

  /** 单点探测：/api/health，默认 2 秒超时 */
  async function probe(base) {
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null
    var timer = 0
    var opt = { cache: 'no-store' }
    if (ctrl) {
      opt.signal = ctrl.signal
      timer = setTimeout(function () { ctrl.abort() }, PROBE_TIMEOUT)
    }
    try {
      var res = await fetch(base + PROBE_PATH, opt)
      if (!res || (!res.ok && res.status !== 0)) {
        return { ok: false, reason: 'HTTP ' + (res ? res.status : '无响应') }
      }
      var j = null
      try { j = await res.json() } catch (e2) { j = null }
      if (j && j.ok === false) return { ok: false, reason: j.message || '服务未就绪' }
      return { ok: true, reason: '可用' }
    } catch (e) {
      return { ok: false, reason: errReason(e, PROBE_TIMEOUT, '探测') }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 轮询解析基址：每轮并行探测全部候选，全失败则间隔 PROBE_INTERVAL 重试，
   * 直到命中或超出窗口（win 毫秒）。窗口内 resolvedBase 保持 null，调用方只需 await。
   */
  async function resolveBase(win) {
    var windowMs = (typeof win === 'number' && win > 0) ? Math.min(win, PROBE_WINDOW) : PROBE_WINDOW
    var list = candidates()
    lastTried = []
    lastFail = null

    if (!list.length) {
      resolvedBase = ''
      status = { phase: 'fail', round: 0, elapsed: 0, window: windowMs }
      notify()
      return resolvedBase
    }

    var start = Date.now()
    var round = 0

    while (true) {
      round++
      /* 并行探测；任一候选成功即立即锁定（不等最慢的候选超时），缩短冷启动等待 */
      var reasons = {}
      var picked = await new Promise(function (resolve) {
        var pending = list.length
        var done = false
        list.forEach(function (b) {
          probe(b).then(function (r) {
            pending--
            reasons[b] = r.reason
            if (!done && r.ok) {
              done = true
              resolve(b)
              return
            }
            if (!done && pending <= 0) {
              done = true
              resolve('')
            }
          })
        })
      })

      var elapsed = Date.now() - start
      if (picked) {
        lastTried = list.map(function (b) {
          return { base: b, reason: b === picked ? '可用' : (reasons[b] || '未响应') }
        })
        resolvedBase = picked
        lastOkBase = picked
        status = { phase: 'ok', round: round, elapsed: elapsed, window: windowMs }
        saveBase(picked)
        notify()
        try { console.info('[api] base = ' + picked + '（第 ' + round + ' 轮命中，用时 ' + elapsed + 'ms）') } catch (e) {}
        return resolvedBase
      }

      status = { phase: 'probing', round: round, elapsed: elapsed, window: windowMs }
      notify()

      if (elapsed + PROBE_INTERVAL >= windowMs) break
      await sleep(PROBE_INTERVAL)
    }

    resolvedBase = ''
    lastTried = list.map(function (b) {
      return { base: b, reason: reasons[b] || ('探测超时（' + (Math.round(PROBE_TIMEOUT / 100) / 10) + ' 秒无响应）') }
    })
    status = { phase: 'fail', round: round, elapsed: Date.now() - start, window: windowMs }
    notify()
    try {
      console.warn('[api] ' + status.elapsed + 'ms 内未探测到可用服务：' + lastTried.map(function (t) {
        return t.base + ' -> ' + t.reason
      }).join(' | '))
    } catch (e) {}
    scheduleRecover(3000)   /* 窗口用尽：后台继续轻量自愈，服务起来后自动恢复 */
    return resolvedBase
  }

  /** 等待基址就绪（并发请求共享同一次探测；win 可指定窗口） */
  function ready(win) {
    if (resolvedBase !== null) return Promise.resolve(resolvedBase)
    if (!readyPromise) {
      readyPromise = resolveBase(win).catch(function () {
        resolvedBase = ''
        status = { phase: 'fail', round: status.round, elapsed: status.elapsed, window: status.window }
        notify()
        scheduleRecover(3000)
        return resolvedBase
      })
    }
    return readyPromise
  }

  /* 后台自愈：探测窗口用尽后仍定期轻量重探，服务恢复时无需用户手动点重试 */
  var recoverTimer = 0
  var recoverLeft = 20
  function scheduleRecover(delayMs) {
    if (recoverTimer || resolvedBase) return
    if (recoverLeft <= 0) return
    recoverTimer = setTimeout(function () {
      recoverTimer = 0
      recoverLeft--
      if (resolvedBase) return          /* 已有可用基址，无需自愈 */
      if (status.phase === 'probing') { scheduleRecover(1500); return }
      invalidate()
      ready(4000).then(function (b) {
        if (!b) scheduleRecover(3000)
      })
    }, typeof delayMs === 'number' ? delayMs : 3000)
  }

  /** 作废当前基址，下次 ready() 重新探测 */
  function invalidate() {
    resolvedBase = null
    readyPromise = null
    status = { phase: 'idle', round: 0, elapsed: 0, window: PROBE_WINDOW }
  }

  /** 当前生效的接口基址；空字符串表示与页面同源 */
  function base() {
    if (resolvedBase !== null) return resolvedBase
    // 探测尚未完成：先按优先级给出预估值，仅供 UI 拼装资源地址
    var injected = injectedBase()
    if (injected) return injected
    return loadBase()
  }

  function url(path) {
    return base() + path
  }

  function httpErr(data, res, path) {
    var m = (data && (data.message || data.detail || data.error)) || ('HTTP ' + (res ? res.status : '?'))
    var s = String(m)
    if (!/HTTP/.test(s) && res && res.status >= 400) s = s + '（HTTP ' + res.status + '）'
    return { kind: 'http', reason: s, path: path }
  }

  /** 失败时的人类可读诊断文案：区分"服务不可达"与"服务可达但接口异常" */
  function diagText() {
    var rows = []

    /* 探测窗口内未找到任何可用基址时，优先展示探测结论，避免被同源页面的 HTTP 异常掩盖 */
    if (lastFail && lastFail.kind === 'http' && (resolvedBase || !lastTried.length)) {
      return '服务地址 ' + (lastFail.base || '同源（当前页面）') + ' 可访问，但接口 ' + lastFail.path +
        ' 返回异常：' + lastFail.reason + '。这不是网络问题，请稍后重试或更换音源。'
    }

    for (var i = 0; i < lastTried.length; i++) {
      var t = lastTried[i]
      var reason = t.reason
      if (lastFail && lastFail.base === t.base) reason = lastFail.reason
      rows.push(t.base + '（' + reason + '）')
    }
    if (lastFail && lastFail.base && !rows.length) rows.push(lastFail.base + '（' + lastFail.reason + '）')

    if (rows.length) {
      if (lastFail && lastFail.kind === 'network') {
        return '已尝试地址：' + rows.join('、') + '；均不可用（' + lastFail.reason + '），请确认服务是否已启动。'
      }
      return '已尝试地址：' + rows.join('、') + '；均不可用，请确认服务是否已启动。'
    }

    var cur = base()
    if (lastFail && lastFail.reason) {
      return '当前接口地址：' + (cur || '同源（当前页面）') + '，' + lastFail.reason + '。'
    }
    return '当前接口地址：' + (cur || '同源（当前页面）') + '，请求失败，请确认服务是否已启动。'
  }

  /** 带超时的 fetch（业务请求用，避免请求悬挂导致页面一直转圈） */
  async function fetchWithTimeout(target, opt, ms) {
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null
    var timer = 0
    var o = Object.assign({}, opt || {})
    if (ctrl) {
      o.signal = ctrl.signal
      timer = setTimeout(function () { ctrl.abort() }, ms)
    }
    try {
      return await fetch(target, o)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 统一请求：网络类异常时自动作废基址、重新探测并重发一次；
   * HTTP 业务异常（如 500）不重探，直接抛出并记录真实原因。
   */
  async function request(path, options) {
    var opt = Object.assign({}, options || {})
    var hasBody = opt.body !== undefined && opt.body !== null
    // 仅在有 body 时才声明 JSON，避免 GET 触发 CORS 预检
    opt.headers = Object.assign(hasBody ? { 'Content-Type': 'application/json' } : {}, opt.headers || {})

    for (var attempt = 0; attempt < 2; attempt++) {
      var cur = await ready(attempt === 0 ? undefined : RETRY_WINDOW)
      var res
      try {
        res = await fetchWithTimeout(cur + path, opt, REQUEST_TIMEOUT)
      } catch (e) {
        var reason = errReason(e, REQUEST_TIMEOUT, '请求')
        lastFail = { path: path, base: cur, kind: 'network', reason: reason }
        invalidate()
        if (attempt === 0) continue   // 重新探测后再试一次
        scheduleRecover(2000)
        throw new Error('无法连接服务：' + (cur || '同源（当前页面）') + '，原因：' + reason + '。' + diagText())
      }

      var data = null
      if (res && res.status !== 204) {
        try {
          data = await res.json()
        } catch (e3) {
          data = null
        }
      }

      if (res && res.status >= 400) {
        var he = httpErr(data, res, path)
        lastFail = { path: path, base: cur, kind: 'http', reason: he.reason }
        notify()
        throw new Error(he.reason)
      }
      if (data && data.ok === false) {
        var he2 = httpErr(data, res, path)
        lastFail = { path: path, base: cur, kind: 'http', reason: he2.reason }
        notify()
        throw new Error(he2.reason)
      }
      if (!data) {
        throw new Error('服务返回异常 (HTTP ' + (res ? res.status : '?') + ')：' + (cur || '同源（当前页面）') + path)
      }

      /* 成功：清掉同路径的历史失败记录，保证"可用"标记与实际结果一致 */
      if (lastFail && lastFail.path === path) lastFail = null
      return data
    }
    throw new Error('请求失败：' + (base() || '同源（当前页面）') + path)
  }

  function qs(obj) {
    return Object.keys(obj || {})
      .filter(function (k) { return obj[k] !== undefined && obj[k] !== null })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]) })
      .join('&')
  }

  var API = {
    /* ---- 服务信息 ---- */
    health: function () { return request('/api/health') },
    sources: function () { return request('/api/sources') },
    paths: function () { return request('/api/paths') },

    /* ---- 搜索 / 曲库 ---- */
    search: function (kw, page, limit, platform) {
      return request('/api/search?' + qs({
        kw: kw,
        page: page || 1,
        limit: limit || 30,
        platform: platform || 'kw',
      }))
    },
    songUrl: function (song, quality) {
      return request('/api/song/url?' + qs({
        quality: quality || '',
        info: JSON.stringify(song || {}),
      }))
    },
    /* 预取播放地址：服务端后台解析，返回后不等待结果 */
    songUrlPrefetch: function (songs, quality) {
      return request('/api/song/url/prefetch', {
        method: 'POST',
        body: JSON.stringify({ list: songs || [], quality: quality || '' }),
      })
    },
    lyric: function (song) {
      if (typeof song === 'string') return request('/api/song/lyric?' + qs({ songmid: song }))
      return request('/api/song/lyric?' + qs({ info: JSON.stringify(song || {}) }))
    },
    toplists: function () { return request('/api/toplists') },
    toplist: function (id, page, limit) {
      return request('/api/toplist?' + qs({ id: id, page: page || 1, limit: limit || 60 }))
    },
    playlist: function (id) { return request('/api/playlist?' + qs({ id: id })) },
    recommend: function () { return request('/api/recommend') },
    /* 每日同步（排行榜/新歌/推荐歌单/歌手），当日缓存由服务端落盘 */
    daily: function (force) {
      return request('/api/daily' + (force ? '?force=1' : ''))
    },

    /* ---- 本地库 ---- */
    library: function () { return request('/api/library') },
    favorite: function (song, action) {
      return request('/api/library/favorite', { method: 'POST', body: JSON.stringify({ song: song, action: action || 'add' }) })
    },
    playlistCreate: function (name) {
      return request('/api/library/playlist/create', { method: 'POST', body: JSON.stringify({ name: name }) })
    },
    playlistDelete: function (id) {
      return request('/api/library/playlist/delete', { method: 'POST', body: JSON.stringify({ id: id }) })
    },
    playlistRename: function (id, name) {
      return request('/api/library/playlist/rename', { method: 'POST', body: JSON.stringify({ id: id, name: name }) })
    },
    playlistAdd: function (id, song) {
      return request('/api/library/playlist/add', { method: 'POST', body: JSON.stringify({ id: id, song: song }) })
    },
    playlistRemove: function (id, song) {
      return request('/api/library/playlist/remove', { method: 'POST', body: JSON.stringify({ id: id, song: song }) })
    },

    /* ---- 外部歌单导入（QQ音乐 / 网易云 / 酷狗 / 纯文本） ---- */
    /* 解析预览：只解析不入库，用于先看结果 */
    playlistImportPreview: function (text) {
      return request('/api/playlist/import/preview?' + qs({ text: text }))
    },
    /* 导入并落本地歌单 */
    playlistImport: function (text, name) {
      return request('/api/playlist/import', { method: 'POST', body: JSON.stringify({ text: text, name: name || '' }) })
    },
    /* 导入歌曲「歌名+歌手」-> 音源可播放歌曲 */
    songResolve: function (name, singer, platform) {
      return request('/api/song/resolve?' + qs({ name: name, singer: singer, platform: platform || '' }))
    },

    /* ---- 历史 ---- */
    history: function () { return request('/api/history') },
    historyAdd: function (song) {
      return request('/api/history', { method: 'POST', body: JSON.stringify({ song: song }) })
    },
    historyClear: function () {
      return request('/api/history', { method: 'POST', body: JSON.stringify({ clear: true }) })
    },

    /* ---- 配置 ---- */
    config: function () { return request('/api/config') },
    setConfig: function (patch) {
      return request('/api/config', { method: 'POST', body: JSON.stringify(patch || {}) })
    },

    /* ---- 下载 ---- */
    download: function (song, quality) {
      return request('/api/download', { method: 'POST', body: JSON.stringify({ song: song, quality: quality }) })
    },
    downloadTasks: function () { return request('/api/download/tasks') },

    /* v3.10 下载管理 */
    downloadList: function () { return request('/api/download/list') },
    downloadRemove: function (name) {
      return request('/api/download/remove', { method: 'POST', body: JSON.stringify({ name: name }) })
    },
    downloadFileUrl: function (name) {
      return url('/api/download/file?name=' + encodeURIComponent(name))
    },

    /* v62 在线点歌自动匹配本地高音质文件：按 歌手+歌名 查本地库（服务端内存索引） */
    localFind: function (singer, name, opts) {
      opts = opts || {}
      var qs = '?singer=' + encodeURIComponent(singer || '') + '&name=' + encodeURIComponent(name || '')
      if (opts.any) qs += '&any=1'
      if (opts.refresh) qs += '&refresh=1'
      if (opts.limit) qs += '&limit=' + encodeURIComponent(opts.limit)
      return request('/api/local/find' + qs)
    },
  }

  /**
   * 设备像素比换算：CSS 边长 -> 需要的真实像素边长
   * @param {number} cssPx 元素在设备上的 CSS 边长
   * @param {number} [min] 下限（默认 160），避免小缩略图请求过大
   */
  API.coverPx = function (cssPx, min) {
    var dpr = (window.devicePixelRatio || 1)
    var n = Math.round((Number(cssPx) || 0) * dpr)
    var lo = min || 160
    if (!isFinite(n) || n < lo) n = lo
    if (n > 1000) n = 1000
    return n
  }

  /** 音频/封面代理地址：一律走服务端 /api/proxy 转发，使用探测后的基址；px 为封面目标像素边长 */
  API.proxyUrl = function (target, px) {
    var u = url('/api/proxy?url=' + encodeURIComponent(target))
    if (px) u += '&px=' + encodeURIComponent(px)
    return u
  }

  /**
   * 资源地址：远程地址走代理，本地/相对/data 地址原样返回
   * 传 px 时服务端会把各平台封面重写为大尺寸原图（避免播放页圆形唱片发虚）
   */
  API.mediaUrl = function (src, px) {
    if (!src) return ''
    var s = String(src)
    if (/^https?:\/\//i.test(s)) return API.proxyUrl(s, px)
    return s
  }

  API.getBase = base
  API.ready = ready
  API.diagText = diagText
  API.status = statusInfo
  API.onStatus = onStatus
  API.lastTried = function () { return lastTried.slice() }
  /** 重新探测；win 为轮询窗口（毫秒），默认沿用冷启动窗口 */
  API.reprobe = function (win) {
    invalidate()
    return ready(win)
  }
  API.setBase = function (v) {
    // 手动设置时覆盖注入值并立即生效，同时作废旧探测结果
    var t = normalize(v)
    window.__API_BASE__ = t
    saveBase(t)
    invalidate()
    resolvedBase = t
    readyPromise = null
    status = { phase: 'ok', round: 0, elapsed: 0, window: PROBE_WINDOW }
    lastFail = null
    notify()
    return t
  }

  window.API = API
})()
