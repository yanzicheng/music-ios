/* ===========================================================
   iOS 基址优先探测（在 js/api.js 之前加载）
   目的：让 iOS 上的接口基址优先锁定 http://127.0.0.1:34200，
        而不是先白白探测安卓模拟器别名 10.0.2.2。
   约束（不得破坏原有逻辑）：
     1. 不覆盖 window.__API_BASE__（构建注入 / 用户手动指定），仅在为空时补充；
     2. 不覆盖 localStorage 里用户手动设置过的基址（键名 lx.apiBase，与 api.js 一致）；
     3. 探测失败不做任何改写，交由 api.js 自身的 18 秒冷启动轮询兜底；
     4. 探测单次超时 2 秒，最多 12 轮（约 6 秒），成功即停止。
   =========================================================== */
(function () {
  'use strict'

  var IOS_BASE = 'http://127.0.0.1:34200'
  var PROBE_PATH = '/api/health'
  var PROBE_TIMEOUT = 2000
  var INTERVAL = 500
  var MAX_ROUNDS = 12
  var LS_KEY = 'lx.apiBase'
  var ANDROID_EMU_ALIAS = 'http://10.0.2.2:34200'

  function normalize(v) {
    return String(v == null ? '' : v).trim().replace(/\/+$/, '')
  }

  function isIOS() {
    try {
      if (window.cordova && window.cordova.platformId === 'ios') return true
    } catch (e) {}
    return /iPad|iPhone|iPod/.test(navigator.userAgent || '')
  }

  function injected() {
    return (typeof window.__API_BASE__ === 'string') ? normalize(window.__API_BASE__) : ''
  }

  function manual() {
    try { return normalize(localStorage.getItem(LS_KEY) || '') } catch (e) { return '' }
  }

  /** 清理安卓模拟器别名残留：iOS 上它永远打不通，留着只会拖慢首屏 */
  function dropStaleAndroidAlias() {
    try {
      var v = normalize(localStorage.getItem(LS_KEY) || '')
      if (v === ANDROID_EMU_ALIAS) localStorage.removeItem(LS_KEY)
    } catch (e) {}
  }

  function probeOnce() {
    var ctrl = null
    var timer = null
    var opts = { method: 'GET', cache: 'no-store', credentials: 'omit' }
    try {
      if (typeof AbortController === 'function') {
        ctrl = new AbortController()
        opts.signal = ctrl.signal
      }
    } catch (e) {}
    return new Promise(function (resolve) {
      timer = setTimeout(function () {
        try { if (ctrl) ctrl.abort() } catch (e) {}
        resolve(false)
      }, PROBE_TIMEOUT)
      fetch(IOS_BASE + PROBE_PATH, opts).then(function (resp) {
        resolve(!!(resp && resp.ok))
      }).catch(function () {
        resolve(false)
      }).then(function () {
        clearTimeout(timer)
      })
    })
  }

  /** 轮询确认服务端是否已就绪，仅用于打日志（基址已同步注入，不影响 api.js 排序） */
  function confirmLoop() {
    var round = 0
    function tick() {
      if (round >= MAX_ROUNDS) return
      round += 1
      probeOnce().then(function (ok) {
        if (ok) {
          try { console.log('[api-base] 本地服务就绪 ' + IOS_BASE + '（第 ' + round + ' 次探测）') } catch (e) {}
          return
        }
        setTimeout(tick, INTERVAL)
      })
    }
    tick()
  }

  if (!isIOS()) return
  if (injected() || manual()) {
    /* 已有明确基址来源，尊重原逻辑，不做任何改写 */
    return
  }

  dropStaleAndroidAlias()

  /* 同步注入：让 api.js 的候选列表把 127.0.0.1 排到首位，
     避免 iOS 上先花 3.5 秒去探测永远打不通的安卓模拟器别名 10.0.2.2 */
  window.__IOS_BASE__ = IOS_BASE
  window.__API_BASE__ = IOS_BASE
  confirmLoop()
})()
