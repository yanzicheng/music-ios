'use strict'
/**
 * iOS 内嵌运行时的启动入口（nodejs-mobile 加载此文件）。
 *
 * 与安卓版 app-android/assets/nodejs-project/main.js 的分工完全一致：
 * 在 require('./server/index.js') 之前，把「数据根目录 / 前端目录 / 音源目录 / 监听地址」
 * 全部用环境变量注入，使 app/server 的源码无需为 iOS 单独分叉。
 *
 * iOS 与安卓的关键差异（本文件存在的意义）：
 *  1. App Bundle 在 iOS 上是只读的，不能像安卓那样把「数据 / 下载 / 缓存 / 日志」写进代码目录；
 *     因此数据根目录改用 cordova.app.datadir()（沙盒 Documents 下），代码目录只读挂载。
 *  2. iOS 进入后台时 node 线程需要主动释放 pauseLock，否则会被系统看门狗强杀。
 *
 * 调试提示：桌面端直接跑 app/server/index.js，不经过本文件（本文件依赖 cordova-bridge）。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const net = require('net')

/** 只读代码目录：App Bundle 内的 www/nodejs-project（server/、音源/ 都在这里） */
const CODE_DIR = __dirname

/* ------------------------------------------------------------------ *
 * 1. cordova-bridge（仅 App 内嵌运行时提供；桌面调试时缺失，降级为无桥接运行）
 * ------------------------------------------------------------------ */
let cordova = null
try {
  cordova = require('cordova-bridge')
} catch (e) {
  console.warn('[main] cordova-bridge 不可用（非 App 内嵌运行时？）:', e.message)
}

/* ------------------------------------------------------------------ *
 * 2. 解析可写数据根目录（沙盒 Documents/MusicPlayerData）
 * ------------------------------------------------------------------ */
function resolveDataRoot () {
  if (cordova && cordova.app && typeof cordova.app.datadir === 'function') {
    try {
      const d = cordova.app.datadir()
      if (d) return path.join(d, 'MusicPlayerData')
    } catch (e) {
      console.error('[main] cordova.app.datadir() 调用失败:', e.message)
    }
  }
  // 兜底：仅本地调试会走到这里，避免直接崩在启动阶段
  return path.join(os.tmpdir(), 'MusicPlayerData')
}

/** 把日志 / 错误回传到页面（无桥接时静默丢弃） */
function report (level, msg) {
  const line = '[node] [' + level + '] ' + msg
  if (level === 'error') console.error(line)
  else console.log(line)
  try {
    if (cordova && cordova.channel && typeof cordova.channel.post === 'function') {
      cordova.channel.post('node-log', { level: level, message: String(msg) })
    }
  } catch (e) { /* 页面未就绪时忽略 */ }
}

/* ------------------------------------------------------------------ *
 * 3. 注入环境变量（server 侧的读取点见 app/server/index.js 与 store.js）
 * ------------------------------------------------------------------ */
const DATA_ROOT = resolveDataRoot()

process.env.LX_ROOT = DATA_ROOT                       // 数据 / 下载 / 缓存 / 日志 的根
process.env.LX_HOST = '127.0.0.1'                     // 仅回环，不对外暴露
process.env.LX_PORT = process.env.LX_PORT || '34200'
process.env.TMPDIR = path.join(DATA_ROOT, 'tmp')      // 音源脚本可能落临时文件

/**
 * 前端静态目录（供服务端 /m 路由使用）。
 * 当前布局：www/nodejs-project/main.js —— 因此前端就是 nodejs-project 的**父目录** www。
 * 其余候选仅用于兼容「nodejs-project 与 www 平级」「已有 ui-mobile 目录」等历史布局。
 */
process.env.LX_MOBILE_DIR = (function () {
  const candidates = [
    path.join(CODE_DIR, '..'),            // = www（当前布局，html/js/css/img 都在这里）
    path.join(CODE_DIR, '..', 'www'),     // = www/www（保留兜底，正常不存在）
    path.join(CODE_DIR, 'www'),           // 若把前端也塞进 nodejs-project/www
    path.join(CODE_DIR, '..', 'ui-mobile'),
    path.join(CODE_DIR, 'ui-mobile'),
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(path.join(p, 'index.html'))) return path.resolve(p)
    } catch (e) { /* 继续找下一个 */ }
  }
  return path.resolve(candidates[0])
})()

/** 音源脚本目录：打包时保持 音源/ 原名，同时兼容 sources/ 目录名 */
process.env.LX_SRC_DIR = (function () {
  const candidates = [path.join(CODE_DIR, '音源'), path.join(CODE_DIR, 'sources')]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch (e) { /* 继续找下一个 */ }
  }
  return candidates[0]
})()

/* ------------------------------------------------------------------ *
 * 4. 预建可写目录 + 切换工作目录（任何相对路径写入都落到沙盒，而不是只读 Bundle）
 * ------------------------------------------------------------------ */
for (const d of ['', '缓存', '缓存/封面', '缓存/歌词', '日志', '下载', '数据', 'tmp']) {
  try {
    fs.mkdirSync(path.join(DATA_ROOT, d), { recursive: true })
  } catch (e) {
    console.error('[main] 建目录失败', d || '/', e.message)
  }
}

try {
  process.chdir(DATA_ROOT)
} catch (e) {
  console.error('[main] chdir 失败:', e.message)
}

/* ------------------------------------------------------------------ *
 * 5. 前后台切换：pause 必须释放 pauseLock，否则 iOS 会强行终止进程
 *    注册时机早于服务端启动，避免冷启动阶段切后台漏掉事件。
 * ------------------------------------------------------------------ */
function setupAppLifecycle () {
  if (!cordova || !cordova.app || typeof cordova.app.on !== 'function') return

  cordova.app.on('pause', function (pauseLock) {
    report('info', 'app paused')
    // 释放后 iOS 才允许本进程挂起；音频是否继续播放取决于 AVAudioSession 类别
    // （见 README「后台播放」一节，需 AppDelegate 里设置 playback 类别）。
    try {
      if (pauseLock && typeof pauseLock.release === 'function') pauseLock.release()
    } catch (e) {
      report('error', 'pauseLock.release 失败: ' + e.message)
    }
  })

  cordova.app.on('resume', function () {
    report('info', 'app resumed')
  })

  // 部分插件版本用 start/stop 命名，一并挂上，避免事件名不一致导致日志缺失
  cordova.app.on('stop', function () { report('info', 'app stop') })
  cordova.app.on('start', function () { report('info', 'app start') })
}

/* ------------------------------------------------------------------ *
 * 6. 端口占用兜底：等 34200 释放后再拉起服务端（冷启动 / 热重载都可能残留监听）
 * ------------------------------------------------------------------ */
const HOST = process.env.LX_HOST
const PORT = Number(process.env.LX_PORT)

function canBind () {
  return new Promise(function (resolve) {
    const srv = net.createServer()
    srv.once('error', function () { resolve(false) })
    srv.once('listening', function () { srv.close(function () { resolve(true) }) })
    try {
      srv.listen(PORT, HOST)
    } catch (e) {
      resolve(false)
    }
  })
}

function sleep (ms) {
  return new Promise(function (r) { setTimeout(r, ms) })
}

async function bootstrap () {
  report('info', '内嵌运行时启动 ' + JSON.stringify({
    code: CODE_DIR,
    root: DATA_ROOT,
    mobile: process.env.LX_MOBILE_DIR,
    sources: process.env.LX_SRC_DIR,
    port: PORT
  }))

  /* v55（真机问题 5）：原来等端口释放最多 30 秒，二次启动时上一个进程的监听还没退，
     前端就得干等半分钟。真机上端口要释放通常 1 秒内就完成，这里收紧到 5 秒；
     仍被占用说明旧实例还在正常服务，直接启用新实例会 EADDRINUSE，故不再硬等。 */
  const deadline = Date.now() + 5000
  let retries = 0
  while (Date.now() < deadline) {
    if (await canBind()) break
    if (retries === 0) report('warn', '端口 ' + PORT + ' 被占用，等待释放')
    retries += 1
    await sleep(250)
  }
  const free = await canBind()
  report('info', '端口检查完成 free=' + free + ' retries=' + retries)

  require('./server/index.js')
}

/* ------------------------------------------------------------------ *
 * 7. 异常兜底：任何未捕获异常都回传页面，避免只剩一个白屏
 * ------------------------------------------------------------------ */
process.on('uncaughtException', function (err) {
  report('error', '未捕获异常: ' + ((err && err.stack) || err))
})
process.on('unhandledRejection', function (err) {
  report('error', '未处理 Promise 拒绝: ' + ((err && err.stack) || err))
})

setupAppLifecycle()

bootstrap().catch(function (err) {
  report('error', '启动失败: ' + ((err && err.stack) || err))
  process.exit(1)
})
