/* ===========================================================
   Cordova 入口（iOS）
   职责：
     1. deviceready 之后启动内嵌 Node 运行时（nodejs.start('main.js')）
     2. 启动失败做有限次重试（首次启动初始化内核偶发失败）
     3. 任何启动异常都以顶部浮层形式反馈到页面，避免只留一个白屏
   说明：
     - nodejs.start() 由 @red-mobile/nodejs-mobile-cordova 插件注入 window.nodejs
     - main.js 位于 www/nodejs-project/ 目录（插件强制约定路径），由插件随 App 一起打包
       nodejs.start('main.js') 中的 'main.js' 是相对 www/nodejs-project 的路径，勿写绝对路径
   =========================================================== */
(function () {
  'use strict'

  var START_RETRY = 3          /* start 失败重试次数 */
  var RETRY_DELAY = 1500       /* 重试间隔 ms */

  var started = false
  var attempts = 0

  function overlay(text, kind) {
    try {
      var id = '__ios_boot_tip__'
      var el = document.getElementById(id)
      if (!el) {
        el = document.createElement('div')
        el.id = id
        el.style.cssText = [
          'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:2147483647',
          'padding:calc(env(safe-area-inset-top, 0px) + 10px) 14px 10px',
          'font-size:13px', 'line-height:1.5', 'color:#fff',
          'background:rgba(0,0,0,.78)', 'white-space:pre-wrap', 'word-break:break-all'
        ].join(';')
        document.body.appendChild(el)
      }
      el.textContent = text
      el.style.background = kind === 'error' ? 'rgba(180,20,20,.92)' : 'rgba(0,0,0,.78)'
      if (!text) el.parentNode && el.parentNode.removeChild(el)
    } catch (e) { /* 页面未就绪时忽略 */ }
  }

  function log(msg) {
    try { console.log('[cordova-entry] ' + msg) } catch (e) {}
  }

  /** 把内嵌 Node 的日志接到控制台，便于 Xcode 控制台排查 */
  function hookNodeChannel() {
    try {
      if (window.nodejs && window.nodejs.channel && typeof window.nodejs.channel.setListener === 'function') {
        window.nodejs.channel.setListener(function (msg) {
          log('node message: ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)))
        })
      }
    } catch (e) { /* 忽略 */ }
  }

  function startNode() {
    if (started) return
    if (!window.nodejs || typeof window.nodejs.start !== 'function') {
      overlay('内嵌 Node 运行时未注入：@red-mobile/nodejs-mobile-cordova 插件未安装或未准备完成。', 'error')
      return
    }
    attempts += 1
    try {
      window.nodejs.start('main.js')
      started = true
      log('nodejs.start(main.js) 已调用，第 ' + attempts + ' 次')
      overlay('')
    } catch (e) {
      log('nodejs.start 失败: ' + (e && e.message ? e.message : e))
      if (attempts < START_RETRY) {
        overlay('本地服务启动中（第 ' + attempts + '/' + START_RETRY + ' 次）…')
        setTimeout(startNode, RETRY_DELAY)
      } else {
        overlay('本地服务启动失败：' + (e && e.message ? e.message : String(e)), 'error')
      }
    }
  }

  function onDeviceReady() {
    log('deviceready, platformId=' + (window.cordova && window.cordova.platformId))
    hookNodeChannel()
    startNode()

    /* 页面长时间停留前台时，若因内存回收导致 node 停摆，补一次启动机会 */
    document.addEventListener('resume', function () {
      if (!started) startNode()
    }, false)
  }

  document.addEventListener('deviceready', onDeviceReady, false)

  /* 非 Cordova 环境（浏览器直接打开 www）不启动 node，仅提示一次 */
  if (!window.cordova) {
    setTimeout(function () {
      if (!window.cordova) log('非 Cordova 环境，跳过 node 启动（仅前端静态预览）')
    }, 3000)
  }
})()
