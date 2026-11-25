'use strict'
/**
 * 音乐播放器本地服务
 * - 静态资源: app/ui
 * - API: /api/*
 * - 所有缓存与下载均落在 D:\学习\音乐 内
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { URL } = require('node:url')

const { Store } = require('./store')
const { SourceManager, QUALITY_FALLBACK, PLATFORM_RANK } = require('./sourceManager')
const tx = require('./sources/tx')
const txWeb = require('./sources/txWeb')
const kwSource = require('./sources/kw')
const cover = require('./cover')
const playlistImport = require('./playlistImport')
const dailySync = require('./dailySync')

// 数据根目录：安卓内嵌运行时由 main.js 通过 LX_ROOT 注入（App 私有目录），桌面端保持原逻辑
const ROOT = process.env.LX_ROOT ? path.resolve(process.env.LX_ROOT) : path.resolve(__dirname, '../..')
const UI_DIR = path.join(__dirname, '../ui')
/**
 * 移动端前端目录（/m 路径根）
 * 兼容三种实际布局：
 *   桌面端    D:\学习\音乐\ui-mobile
 *   安卓内嵌  assets/nodejs-project/ui-mobile   (LX_ROOT 注入 assets 时 ROOT 不含 ui-mobile)
 *   旧安卓    assets/ui-mobile
 * 逐个探测取第一个「带 index.html」的目录，避免布局差异导致 /m 全量 404。
 */
const MOBILE_DIR = (function () {
  if (process.env.LX_MOBILE_DIR) return path.resolve(process.env.LX_MOBILE_DIR)
  const candidates = [
    path.join(ROOT, 'ui-mobile'),
    path.join(__dirname, '..', 'ui-mobile'),
    path.join(ROOT, 'nodejs-project', 'ui-mobile'),
    path.join(ROOT, 'www'),
    path.join(__dirname, '..', 'www'),
  ]
  for (const d of candidates) {
    try { if (fs.existsSync(path.join(d, 'index.html'))) return d } catch (_) {}
  }
  for (const d of candidates) {
    try { if (fs.existsSync(d)) return d } catch (_) {}
  }
  return candidates[0]
})()
const CACHE_DIR = path.join(ROOT, '缓存')
const LOG_DIR = path.join(ROOT, '日志')
const DOWNLOAD_DIR = path.join(ROOT, '下载')

for (const d of [CACHE_DIR, LOG_DIR, DOWNLOAD_DIR, path.join(CACHE_DIR, '封面'), path.join(CACHE_DIR, '歌词')]) {
  // 安卓私有目录可能因权限或残留文件导致建目录失败，不能让它阻断服务启动
  try {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  } catch (e) {
    console.error('[server] 创建目录失败', d, e.message)
  }
}

const PORT = Number(process.env.LX_PORT || 34200)
const HOST = process.env.LX_HOST || '127.0.0.1'

const store = new Store()
const sourceManager = new SourceManager({ log: m => log('source', m) })

function log(tag, ...args) {
  const line = `[${new Date().toISOString()}] [${tag}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`
  try { fs.appendFileSync(path.join(LOG_DIR, 'server.log'), line + '\n') } catch (_) {}
  console.log(line)
}

/* ---------------- 工具 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * 静态资源回落目录
 * 场景：APK 内 ui-mobile 副本可能缺少 img/ 等新增资源（只更新了 www 或反之），
 * 此时若直接 404，页面图标全部裂开。这里在目标目录找不到文件时，
 * 按顺序尝试其它随包目录中的同名相对路径，保证前端资源始终可取。
 */
const STATIC_FALLBACK_DIRS = (function () {
  const dirs = []
  const extra = String(process.env.LX_STATIC_FALLBACK || '').split(path.delimiter).filter(Boolean)
  for (const d of extra) dirs.push(path.resolve(d))
  const candidates = [
    MOBILE_DIR,
    path.join(ROOT, 'www'),
    path.join(ROOT, 'ui-mobile'),
    path.join(__dirname, '..', 'ui-mobile'),
    path.join(__dirname, '..', 'www'),
    path.join(ROOT, 'nodejs-project', 'ui-mobile'),
    path.join(ROOT, 'app-android', 'assets', 'www'),
    path.join(ROOT, 'app-android', 'assets', 'nodejs-project', 'ui-mobile'),
  ]
  for (const d of candidates) {
    try { if (d && fs.existsSync(d) && !dirs.includes(d)) dirs.push(d) } catch (_) {}
  }
  return dirs
})()

function sendJson(res, data, status = 200) {
  const body = Buffer.from(JSON.stringify(data), 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
  res.end(body)
}

function sendErr(res, err, status = 500) {
  sendJson(res, { ok: false, message: err && err.message ? err.message : String(err), detail: err && err.detail }, status)
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const txt = Buffer.concat(chunks).toString('utf8')
      if (!txt) return resolve({})
      try { resolve(JSON.parse(txt)) } catch (e) { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

function serveStatic(req, res, pathname, baseDir) {
  const root = path.resolve(baseDir || UI_DIR)
  let rel = pathname
  try { rel = decodeURIComponent(pathname) } catch (_) { rel = pathname }
  if (rel === '/' || rel === '') rel = '/index.html'
  rel = rel.split('?')[0].split('#')[0]
  const normRel = path.posix.normalize(rel).replace(/^\/+/, '')
  if (normRel.startsWith('..')) { res.writeHead(403); return res.end('Forbidden') }

  const target = path.resolve(root, normRel)
  // 严格前缀校验，防 ../ 越权
  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('403 Forbidden')
  }

  const statSafe = p => new Promise(resolve => {
    fs.stat(p, (err, st) => resolve(err || !st.isFile() ? null : st))
  })

  const send = (filePath, st) => {
    const ext = path.extname(filePath).toLowerCase()
    const head = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'X-Content-Type-Options': 'nosniff',
      // 本地内嵌服务：前端代码一律强制回源校验，避免升级 App 后 WebView 命中旧缓存
      // （旧 app.js 会导致返回键等修复失效）；图片/字体仍可长缓存。
      'Cache-Control': /^\.(html|js|css|json|map)$/.test(ext) ? 'no-cache, must-revalidate'
        : /^\.(png|jpg|jpeg|webp|avif|gif|svg|ico|woff2?|ttf|otf)$/.test(ext)
          ? 'public, max-age=86400'
          : 'public, max-age=3600',
    }
    if (req.method === 'HEAD') { res.writeHead(200, head); return res.end() }
    res.writeHead(200, head)
    fs.createReadStream(filePath).pipe(res)
  }

  statSafe(target).then(st => {
    if (st) return send(target, st)
    // 目标目录缺失 → 依次回落其它随包目录（APK 内 ui-mobile 与 www 只同步了一份的情况）
    const candidates = STATIC_FALLBACK_DIRS
      .filter(d => d !== root)
      .map(d => path.resolve(d, normRel))
    const step = i => {
      if (i >= candidates.length) {
        // 只记一次日志，便于定位「资源到底落在哪个目录」的问题
        try { log('static', '404', rel, 'root=' + root) } catch (_) {}
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end('404 Not Found: ' + rel)
      }
      return statSafe(candidates[i]).then(s2 => (s2 ? send(candidates[i], s2) : step(i + 1)))
    }
    return step(0)
  })
}

/**
 * 音频/图片代理：解决音源地址的 referer 限制与跨域
 * 图片按 px（CSS 像素 x DPR）统一重写为大尺寸原图，避免播放页封面发虚；音频地址不做任何改写。
 */
function proxyStream(req, res, targetUrl, px) {
  let u
  try { u = new URL(targetUrl) } catch (_) {
    res.writeHead(400); return res.end('bad url')
  }
  if (!/^https?:$/.test(u.protocol)) { res.writeHead(400); return res.end('bad protocol') }
  // 图片：按目标像素重写尺寸（各平台规则不同，统一交给 cover 模块）；音频原样转发
  if (cover.isImageUrl(u.href)) {
    const upgraded = cover.upgradeCoverUrl(u.href, px || 600)
    if (upgraded && upgraded !== u.href) {
      try { u = new URL(upgraded) } catch (_) {}
    }
  }
  const lib = u.protocol === 'https:' ? require('node:https') : require('node:http')
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    Referer: u.origin + '/',
    Accept: '*/*',
  }
  if (req.headers.range) headers.Range = req.headers.range

  const upstream = lib.request(u, { method: 'GET', headers, timeout: 30000, rejectUnauthorized: false }, up => {
    const outHeaders = {
      'Content-Type': up.headers['content-type'] || 'application/octet-stream',
      'Accept-Ranges': up.headers['accept-ranges'] || 'bytes',
      'Cache-Control': 'no-store',
    }
    if (up.headers['content-length']) outHeaders['Content-Length'] = up.headers['content-length']
    if (up.headers['content-range']) outHeaders['Content-Range'] = up.headers['content-range']
    res.writeHead(up.statusCode || 200, outHeaders)
    up.pipe(res)
    up.on('error', () => { try { res.end() } catch (_) {} })
  })
  upstream.on('error', e => {
    if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('代理失败: ' + e.message) }
    else try { res.end() } catch (_) {}
  })
  upstream.on('timeout', () => upstream.destroy(new Error('上游超时')))
  req.on('close', () => { try { upstream.destroy() } catch (_) {} })
  upstream.end()
}

/* ---------------- 下载任务 ---------------- */
const downloadTasks = new Map()
let downloadSeq = 0

function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120)
}

const EXT_BY_MIME = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/x-mpeg': 'mp3',
  'audio/x-ogg': 'ogg', 'audio/ogg': 'ogg', 'application/ogg': 'ogg',
  'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/wav': 'wav', 'audio/x-wav': 'wav',
}

/* 按文件头识别真实格式，比 content-type 可靠 */
function magicExt(buf) {
  if (!buf || buf.length < 4) return ''
  const s = buf.slice(0, 12).toString('latin1')
  if (s.startsWith('OggS')) {
    if (buf.indexOf('\x7fFLAC') > -1) return 'flac'
    if (s.indexOf('OpusHead') > -1) return 'opus'
    return 'ogg'
  }
  if (s.startsWith('fLaC')) return 'flac'
  if (s.startsWith('ID3')) return 'mp3'
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3'
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'm4a'
  if (s.startsWith('RIFF')) return 'wav'
  return ''
}

function extOf(urlStr, mime) {
  const m = EXT_BY_MIME[String(mime || '').split(';')[0].trim().toLowerCase()]
  if (m) return m
  try {
    const p = new URL(urlStr).pathname.toLowerCase()
    const e = p.split('.').pop()
    if (['mp3', 'flac', 'ogg', 'm4a', 'aac', 'wav', 'opus'].includes(e)) return e
  } catch (_) {}
  return 'mp3'
}

async function runDownload(task) {
  const { song, quality } = task
  try {
    task.status = 'running'
    const info = await sourceManager.getMusicUrl(song.source || 'tx', song, quality || store.getConfig().quality)
    const dir = store.getConfig().downloadDir || DOWNLOAD_DIR
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const base = safeFileName(`${song.singer ? song.singer + ' - ' : ''}${song.name}`)

    await new Promise((resolve, reject) => {
      const u = new URL(info.url)
      const lib = u.protocol === 'https:' ? require('node:https') : require('node:http')
      const req2 = lib.request(u, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: u.origin + '/' },
        timeout: 90000,
        rejectUnauthorized: false,
      }, r => {
        if (r.statusCode >= 400) return reject(new Error('下载失败 HTTP ' + r.statusCode))
        task.total = Number(r.headers['content-length']) || 0
        let ws = null
        let received = 0
        let pending = []

        const start = dataBuf => {
          const ext = magicExt(dataBuf) || extOf(info.url, r.headers['content-type'])
          let filePath = path.join(dir, `${base}.${ext}`)
          let n = 1
          while (fs.existsSync(filePath)) filePath = path.join(dir, `${base} (${n++}).${ext}`)
          task.filePath = filePath
          task.ext = ext
          ws = fs.createWriteStream(filePath)
          ws.on('error', reject)
          ws.write(dataBuf)
          pending = []
          r.pipe(ws)
          ws.on('finish', resolve)
        }

        r.on('data', c => {
          received += c.length
          task.received = received
          if (!ws) {
            pending.push(c)
            if (received >= 16) start(Buffer.concat(pending))
          }
        })
        r.on('end', () => {
          if (!ws) {
            if (pending.length) start(Buffer.concat(pending))
            else reject(new Error('音频响应为空'))
          }
        })
        r.on('error', reject)
      })
      req2.on('error', reject)
      req2.on('timeout', () => req2.destroy(new Error('下载超时')))
      req2.end()
    })

    const st = fs.statSync(task.filePath)
    task.status = 'done'
    task.size = st.size
    task.quality = info.quality
    task.finishedAt = Date.now()
    log('download', '完成', task.filePath, st.size)
  } catch (e) {
    task.status = 'error'
    task.error = e.message
    log('download', '失败', song.name, e.message)
  }
}

/* ---------------- 导入歌曲匹配（歌名 + 歌手 -> 音源） ---------------- */

const resolveCache = new Map() // key -> { at, song, reason }
const RESOLVE_TTL = 30 * 60 * 1000

function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]/g, '')
    .replace(/[\s\-–—_·・,，。.、'"!！?？:：;；/\\|&+]/g, '')
}

function singerTokens(s) {
  return String(s || '')
    .split(/[\/、,，&;；]+|\s+feat\.?\s+/i)
    .map(x => normText(x))
    .filter(Boolean)
}

/**
 * 给候选项打分：歌名越接近分越高，歌手命中额外加权
 * @returns {number} 0 表示完全不相关
 */
function scoreCandidate(name, singer, cand) {
  const tn = normText(name)
  const cn = normText(cand.name)
  if (!tn || !cn) return 0
  let score = 0
  if (cn === tn) score += 100
  else if (cn.includes(tn) || tn.includes(cn)) score += 62
  else return 0

  const tSinger = singerTokens(singer)
  const cSinger = singerTokens(cand.singer)
  if (tSinger.length && cSinger.length) {
    const hit = tSinger.some(a => cSinger.some(b => a === b || a.includes(b) || b.includes(a)))
    if (hit) score += 34
    else score -= 12
  }
  if (cand.types && cand.types.length) score += 2
  return score
}

const resolveInflight = new Map()

/**
 * 把导入的「歌名 + 歌手」解析成可播放的音源歌曲
 * 策略：酷我搜索优先（曲库覆盖广、取址稳定），不足阈值再用 QQ 音乐兜底
 * @returns {Promise<{song?:object, reason?:string}>}
 */
async function resolveSongOne(name, singer, platform) {
  const key = normText(name) + '|' + normText(singer) + '|' + (platform || '')
  const cached = resolveCache.get(key)
  if (cached && Date.now() - cached.at < RESOLVE_TTL) {
    return cached.song ? { song: cached.song } : { reason: cached.reason }
  }
  if (resolveInflight.has(key)) return resolveInflight.get(key)

  const task = (async () => {
    const keyword = (name + ' ' + singer).trim()
    let best = null
    let bestScore = 0
    const reasons = []

    const trySource = async (label, fn) => {
      try {
        const r = await fn(keyword, 1, 12)
        const list = (r && r.list) || []
        if (!list.length) { reasons.push(label + '无结果'); return }
        for (const s of list) {
          const sc = scoreCandidate(name, singer, s)
          if (sc > bestScore) { bestScore = sc; best = s }
        }
        if (!best) reasons.push(label + '名不匹配')
      } catch (e) {
        reasons.push(label + '搜索失败(' + e.message + ')')
      }
    }

    if (platform === 'tx') {
      await trySource('QQ音乐', tx.search)
      if (bestScore < 90) await trySource('酷我', kwSource.search)
    } else {
      await trySource('酷我', kwSource.search)
      if (bestScore < 90) await trySource('QQ音乐', tx.search)
    }

    let result
    if (best && bestScore >= 60) {
      result = { song: Object.assign({}, best, { matchedName: name, matchedSinger: singer, matchScore: bestScore }) }
    } else {
      result = { reason: '音源里没有匹配到《' + name + (singer ? ' - ' + singer : '') + '》' + (reasons.length ? '（' + reasons.join('；') + '）' : '') }
    }
    resolveCache.set(key, Object.assign({ at: Date.now() }, result))
    if (resolveCache.size > 800) {
      const firstKey = resolveCache.keys().next().value
      resolveCache.delete(firstKey)
    }
    resolveInflight.delete(key)
    return result
  })()

  resolveInflight.set(key, task)
  return task
}

/**
 * 2026-11-19 音质整改：kw 优先取址
 * kw 是当前唯一稳定产出真 24bit 的通道，非 kw 平台（尤其 tx）的歌曲先用「歌名 + 歌手」
 * 在酷我找同一首，高置信命中就改用 kw 取址；酷我曲库确实没有才回落原平台，
 * 从而保证 tx 只在 kw 无结果时兜底，不拿 16bit / MP3 320k 冒充满血音质。
 */
async function preferKwSong(song) {
  const src = (song && song.source) || 'kw'
  const rank = PLATFORM_RANK[src] === undefined ? 9 : PLATFORM_RANK[src]
  if (src === 'kw' || rank <= PLATFORM_RANK.kw || !song.name) return song
  const name = String(song.name || '').trim()
  const singer = String(song.singer || song.artist || song.albumArtist || '').trim()
  if (!name) return song
  try {
    const hit = await resolveSongOne(name, singer, '')
    const cand = hit.song
    if (cand && cand.source === 'kw' && cand.songmid && Number(cand.matchScore || 0) >= 80) {
      log('url', 'kw优先', `${name} - ${singer}：${src} → kw（匹配度 ${cand.matchScore}）`)
      return Object.assign({}, cand, { preferredFrom: src })
    }
    log('url', 'kw未命中', `${name} - ${singer}：回落 ${src}${hit.reason ? '（' + hit.reason + '）' : ''}`)
  } catch (e) {
    log('url', 'kw优先异常', `${name}：${e.message}`)
  }
  return song
}

/* ---------------- 路由 ---------------- */
async function handleApi(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '')
  const q = url.searchParams

  // 健康检查
  if (p === '/health') {
    return sendJson(res, {
      ok: true,
      version: '1.0.0',
      root: ROOT,
      port: PORT,
      sources: sourceManager.list(),
      capabilities: sourceManager.getCapabilities(),
    })
  }

  // 音源列表
  if (p === '/sources') {
    if (!sourceManager.ready) await sourceManager.load()
    return sendJson(res, { ok: true, list: sourceManager.list(), capabilities: sourceManager.getCapabilities() })
  }

  // 音质实测汇总：各音源标称无损 vs 实测真无损命中率（供诊断与界面提示）
  if (p === '/audio/diag') {
    if (!sourceManager.ready) await sourceManager.load()
    return sendJson(res, {
      ok: true,
      tiers: Object.keys(QUALITY_FALLBACK),
      stats: sourceManager.qualityReport(),
    })
  }

  // 搜索（platform: kw=酷我 / tx=QQ音乐）
  if (p === '/search') {
    const keyword = (q.get('kw') || '').trim()
    if (!keyword) return sendErr(res, new Error('缺少搜索关键词'), 400)
    const platform = (q.get('platform') || 'kw').toLowerCase()
    const page = Number(q.get('page') || 1)
    const limit = Math.min(Number(q.get('limit') || 30), 60)
    if (platform === 'tx') {
      const r = await tx.search(keyword, page, limit)
      return sendJson(res, { ok: true, ...r, keyword, platform })
    }
    const r = await kwSource.search(keyword, page, limit)
    return sendJson(res, { ok: true, ...r, keyword, platform: 'kw' })
  }

  // 播放地址预取：前端起播后调用，后台提前解析下一批歌曲，点击时直接命中缓存
  if (p === '/song/url/prefetch') {
    let body = {}
    if (req.method === 'POST') {
      try { body = await readBody(req, 1024 * 1024) } catch (_) { body = {} }
    }
    const list = Array.isArray(body.list) ? body.list : []
    const quality = body.quality || store.getConfig().quality
    const source = body.source || (list[0] && list[0].source) || 'kw'
    // 立即响应，不等解析结果；解析在后台并发进行
    sendJson(res, { ok: true, queued: list.length, quality })

    // 导入歌单的曲目只有元数据：后台先匹配音源，再按来源分组预取真实播放地址
    if (list.some(s => s && s.source === 'import')) {
      ;(async () => {
        const groups = new Map()
        for (const it of list.slice(0, 8)) {
          const nm = String(it.name || '').trim()
          if (!nm) continue
          const r = await resolveSongOne(nm, String(it.singer || '').trim(), it.importPlatform === 'qq' ? 'tx' : '')
          if (!r.song) continue
          const src = r.song.source || 'kw'
          if (!groups.has(src)) groups.set(src, [])
          groups.get(src).push(r.song)
        }
        for (const [src, songs] of groups) {
          await sourceManager.prefetch(src, songs, quality, 3)
        }
      })().catch(() => {})
      return
    }

    // 预取同样走「kw 优先」：先按歌名+歌手换成 kw 歌曲再预解析，避免预热了 tx 的低音质通道
    ;(async () => {
      const mapped = []
      for (const it of list.slice(0, 8)) {
        try { mapped.push(await preferKwSong(it)) } catch (_) { mapped.push(it) }
      }
      sourceManager.prefetch(source, mapped, quality, 3).catch(() => {})
    })().catch(() => {})
    return
  }

  // 播放地址
  if (p === '/song/url') {
    let song = Object.assign({}, Object.fromEntries(q.entries()), JSON.parse(q.get('info') || '{}'))
    delete song.info
    /* 导入歌单的曲目只带元数据：播放前按「歌名 + 歌手」匹配到实际音源歌曲 */
    if (song.source === 'import') {
      const iname = String(song.name || '').trim()
      const isinger = String(song.singer || '').trim()
      if (!iname) return sendErr(res, new Error('该曲目缺少歌名，无法匹配音源'), 400)
      const hit = await resolveSongOne(iname, isinger, song.importPlatform === 'qq' ? 'tx' : '')
      if (!hit.song) return sendErr(res, new Error(hit.reason || ('音源里没有匹配到《' + iname + '》')), 404)
      song = hit.song
    }
    if (!song.songmid && !song.songId) return sendErr(res, new Error('缺少歌曲标识'), 400)
    // 音质优先：非 kw 平台先改用 kw 取址（真 24bit），kw 无结果才让 tx 等平台兜底
    /* v3.19：换平台取址只是"锦上添花"，加 2.5s 上限——搜索接口偶发挂起时不能拖住整首解析 */
    const kwPref = preferKwSong(song)
    kwPref.catch(() => {})
    song = await Promise.race([
      kwPref,
      new Promise(resolve => setTimeout(() => resolve(song), 2500)),
    ])
    if (!song.songmid && !song.songId) return sendErr(res, new Error('缺少歌曲标识'), 400)
    const quality = q.get('quality') || store.getConfig().quality
    const info = await sourceManager.getMusicUrl(song.source || 'kw', song, quality)
    return sendJson(res, {
      ok: true,
      ...info,
      sizeText: info.size ? (info.size / 1048576).toFixed(2) + 'MB' : '',
      proxied: '/api/proxy?url=' + encodeURIComponent(info.url),
    })
  }

  // 歌词
  if (p === '/song/lyric') {
    const song = Object.assign({}, Object.fromEntries(q.entries()), JSON.parse(q.get('info') || '{}'))
    delete song.info
    const key = song.songmid || q.get('songmid')
    if (!key) return sendErr(res, new Error('缺少 songmid'), 400)
    const cacheFile = path.join(CACHE_DIR, '歌词', safeFileName((song.source || 'kw') + '_' + key) + '.json')
    if (fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
        if (cached && (cached.lyric || '').length) return sendJson(res, { ok: true, ...cached, cached: true })
      } catch (_) {}
    }
    let lrc
    if ((song.source || 'kw') === 'kw') lrc = await kwSource.getLyric(song)
    else lrc = await txWeb.getLyric(key)
    if (!lrc || !lrc.lyric) {
      const alt = await sourceManager.getLyric(song.source || 'kw', song)
      if (alt && alt.lyric) lrc = { lyric: alt.lyric, tlyric: '' }
    }
    if (lrc && lrc.lyric) {
      try { fs.writeFileSync(cacheFile, JSON.stringify(lrc), 'utf8') } catch (_) {}
    }
    return sendJson(res, { ok: true, ...lrc })
  }

  // 排行榜列表
  if (p === '/toplists') {
    const list = await txWeb.getTopLists()
    return sendJson(res, { ok: true, list })
  }

  // 排行榜详情
  if (p === '/toplist') {
    const id = Number(q.get('id') || 26)
    const page = Number(q.get('page') || 1)
    const limit = Math.min(Number(q.get('limit') || 60), 100)
    const r = await txWeb.getTopListDetail(id, page, limit)
    return sendJson(res, { ok: true, ...r })
  }

  // 歌单详情
  if (p === '/playlist') {
    const id = q.get('id')
    if (!id) return sendErr(res, new Error('缺少歌单 id'), 400)
    const r = await txWeb.getPlaylist(id)
    return sendJson(res, { ok: true, ...r })
  }

  // 推荐歌单
  if (p === '/recommend') {
    const list = await txWeb.getRecommend()
    return sendJson(res, { ok: true, list })
  }

  // 每日自动同步：排行榜 / 新歌 / 推荐歌单（当日缓存命中即返回，失败降级旧缓存）
  if (p === '/daily') {
    const force = q.get('force') === '1'
    const r = await dailySync.getDaily(txWeb, { force, log })
    return sendJson(res, Object.assign({ ok: true }, r))
  }

  // 本地音乐库
  if (p === '/library') return sendJson(res, { ok: true, ...store.getLibrary() })

  if (p === '/library/favorite') {
    if (req.method !== 'POST') return sendErr(res, new Error('方法不允许'), 405)
    const body = await readBody(req)
    const { song, action } = body
    if (!song) return sendErr(res, new Error('缺少歌曲信息'), 400)
    const lib = action === 'remove' ? store.removeFavorite(song) : store.addFavorite(song)
    return sendJson(res, { ok: true, favorites: lib.favorites })
  }

  if (p.startsWith('/library/playlist')) {
    const body = req.method === 'POST' ? await readBody(req) : {}
    const action = p.replace('/library/playlist', '').replace(/^\//, '')
    if (action === 'create') return sendJson(res, { ok: true, playlist: store.createPlaylist(body.name), ...store.getLibrary() })
    if (action === 'delete') { store.deletePlaylist(body.id); return sendJson(res, { ok: true, ...store.getLibrary() }) }
    if (action === 'rename') { store.renamePlaylist(body.id, body.name); return sendJson(res, { ok: true, ...store.getLibrary() }) }
    if (action === 'add') return sendJson(res, { ok: true, playlist: store.addToPlaylist(body.id, body.song), ...store.getLibrary() })
    if (action === 'remove') return sendJson(res, { ok: true, playlist: store.removeFromPlaylist(body.id, body.song), ...store.getLibrary() })
    return sendErr(res, new Error('未知操作: ' + action), 404)
  }

  /* ---------------- 外部歌单导入（QQ音乐 / 网易云 / 酷狗） ---------------- */

  // 预览：只解析不入库，便于用户在确认前先看结果
  if (p === '/playlist/import/preview') {
    const text = (q.get('text') || '').trim()
    if (!text) return sendErr(res, new Error('请粘贴歌单链接或歌单 ID'), 400)
    try {
      const r = await playlistImport.inspect(text)
      return sendJson(res, {
        ok: true,
        platform: r.platform,
        id: r.id,
        name: r.name,
        cover: r.cover,
        creator: r.creator,
        desc: r.desc,
        songCount: r.songCount,
        songTotal: r.songs.length,
        truncated: r.truncated || '',
        songs: r.songs.slice(0, 30).map((s, i) => ({ seq: i + 1, name: s.name, singer: s.singer, albumName: s.albumName, duration: s.duration, img: s.img })),
      })
    } catch (e) {
      return sendErr(res, new Error(e.message || '歌单解析失败'), 400)
    }
  }

  // 导入：解析并保存为本地歌单（数据落 DATA_DIR/library.json）
  if (p === '/playlist/import') {
    if (req.method !== 'POST') return sendErr(res, new Error('方法不允许'), 405)
    const body = await readBody(req)
    const text = String(body.text || body.url || body.id || '').trim()
    if (!text) return sendErr(res, new Error('请粘贴歌单链接或歌单 ID'), 400)
    let r
    try {
      r = await playlistImport.inspect(text)
    } catch (e) {
      return sendErr(res, new Error(e.message || '歌单解析失败'), 400)
    }
    if (!r.songs.length) return sendErr(res, new Error('歌单解析成功但没有取到任何歌曲，可能歌单为空或接口限制'), 400)

    const meta = { platform: r.platform, name: r.name, cover: r.cover }
    const plName = String(body.name || '').trim() || r.name || '导入歌单'
    const pl = store.createPlaylist(plName)
    const songs = r.songs.map((s, i) => playlistImport.toLocalSong(s, meta, i + 1))
    store.addToPlaylist(pl.id, songs)

    // 附加来源信息，便于前端展示「来自 QQ音乐 / 网易云 / 酷狗」
    const lib = store.getLibrary()
    const saved = lib.playlists.find(x => x.id === pl.id)
    if (saved) {
      saved.imported = true
      saved.importPlatform = r.platform
      saved.importId = r.id
      saved.cover = r.cover
      saved.creator = r.creator
      saved.desc = r.desc
      saved.songTotal = r.songCount
      saved.truncated = r.truncated || ''
      saved.importedAt = Date.now()
      store.saveLibrary(lib)
    }

    log('import', '歌单导入成功', r.platform, r.id, r.name, songs.length)
    return sendJson(res, {
      ok: true,
      playlist: saved || pl,
      imported: {
        platform: r.platform,
        id: r.id,
        name: r.name,
        cover: r.cover,
        creator: r.creator,
        songCount: r.songCount,
        songTotal: songs.length,
        truncated: r.truncated || '',
      },
      ...store.getLibrary(),
    })
  }

  /* ---------------- 导入歌曲 -> 音源匹配 ---------------- */

  // 单曲解析：把「歌名+歌手」匹配到可播放的音源歌曲
  if (p === '/song/resolve') {
    const name = (q.get('name') || '').trim()
    const singer = (q.get('singer') || '').trim()
    if (!name) return sendErr(res, new Error('缺少歌名'), 400)
    const r = await resolveSongOne(name, singer, q.get('platform') || '')
    if (!r.song) return sendJson(res, { ok: false, name, singer, reason: r.reason })
    return sendJson(res, { ok: true, name, singer, song: r.song })
  }

  // 批量解析：导入歌单播放时整单顺序解析，保证连续播放
  if (p === '/song/resolve/batch') {
    if (req.method !== 'POST') return sendErr(res, new Error('方法不允许'), 405)
    const body = await readBody(req, 2 * 1024 * 1024)
    const list = Array.isArray(body.songs) ? body.songs.slice(0, 30) : []
    if (!list.length) return sendErr(res, new Error('缺少歌曲列表'), 400)
    const out = []
    for (const it of list) {
      const name = String(it.name || '').trim()
      const singer = String(it.singer || '').trim()
      if (!name) { out.push({ ok: false, name, singer, reason: '歌名为空' }); continue }
      try {
        const r = await resolveSongOne(name, singer, body.platform || '')
        if (r.song) out.push({ ok: true, name, singer, seq: it.seq, song: r.song })
        else out.push({ ok: false, name, singer, seq: it.seq, reason: r.reason })
      } catch (e) {
        out.push({ ok: false, name, singer, seq: it.seq, reason: '解析失败：' + e.message })
      }
    }
    return sendJson(res, { ok: true, list: out })
  }

  // 播放历史
  if (p === '/history') {
    if (req.method === 'POST') {
      const body = await readBody(req)
      const list = body.clear ? store.clearHistory() : store.addHistory(body.song)
      return sendJson(res, { ok: true, list })
    }
    return sendJson(res, { ok: true, list: store.getHistory() })
  }

  // 配置
  if (p === '/config') {
    if (req.method === 'POST') {
      const body = await readBody(req)
      return sendJson(res, { ok: true, config: store.setConfig(body) })
    }
    return sendJson(res, { ok: true, config: store.getConfig() })
  }

  // 下载
  if (p === '/download') {
    if (req.method !== 'POST') return sendErr(res, new Error('方法不允许'), 405)
    const body = await readBody(req)
    if (!body.song) return sendErr(res, new Error('缺少歌曲信息'), 400)
    const id = 'dl_' + (++downloadSeq)
    const task = { id, song: body.song, quality: body.quality, status: 'pending', createdAt: Date.now(), received: 0, total: 0 }
    downloadTasks.set(id, task)
    runDownload(task)
    return sendJson(res, { ok: true, task })
  }

  if (p === '/download/tasks') {
    return sendJson(res, { ok: true, list: [...downloadTasks.values()].reverse().slice(0, 100) })
  }

  /* ---- v3.10 下载管理：列出 / 播放 / 删除 ---- */
  if (p === '/download/list') {
    const dir = store.getConfig().downloadDir || DOWNLOAD_DIR
    let list = []
    try {
      if (fs.existsSync(dir)) {
        list = fs.readdirSync(dir)
          .filter(n => /\.(mp3|flac|ogg|opus|m4a|aac|wav)$/i.test(n))
          .map(n => {
            const fp = path.join(dir, n)
            let st = null
            try { st = fs.statSync(fp) } catch (_) { return null }
            if (!st || !st.isFile()) return null
            return {
              name: n,
              size: st.size,
              mtime: st.mtimeMs,
              url: '/api/download/file?name=' + encodeURIComponent(n),
            }
          })
          .filter(Boolean)
          .sort((a, b) => b.mtime - a.mtime)
      }
    } catch (e) {
      return sendErr(res, e, 500)
    }
    const total = list.reduce((s, x) => s + x.size, 0)
    return sendJson(res, { ok: true, dir, list, total })
  }

  if (p === '/download/file') {
    const dir = store.getConfig().downloadDir || DOWNLOAD_DIR
    const name = path.basename(String(url.searchParams.get('name') || ''))
    const fp = path.join(dir, name)
    if (!name || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      return sendErr(res, new Error('文件不存在'), 404)
    }
    const size = fs.statSync(fp).size
    const ext = path.extname(fp).toLowerCase()
    const mime = ext === '.flac' ? 'audio/flac'
      : ext === '.m4a' ? 'audio/mp4'
        : ext === '.ogg' || ext === '.opus' ? 'audio/ogg'
          : ext === '.wav' ? 'audio/wav'
            : ext === '.aac' ? 'audio/aac' : 'audio/mpeg'
    const range = req.headers.range
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || []
      const start = m[1] ? parseInt(m[1], 10) : 0
      const end = m[2] ? parseInt(m[2], 10) : size - 1
      if (start >= size || end >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` })
        return res.end()
      }
      res.writeHead(206, {
        'Content-Type': mime,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      })
      return fs.createReadStream(fp, { start, end }).pipe(res)
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    })
    return fs.createReadStream(fp).pipe(res)
  }

  if (p === '/download/remove') {
    if (req.method !== 'POST') return sendErr(res, new Error('方法不允许'), 405)
    const body = await readBody(req)
    const dir = store.getConfig().downloadDir || DOWNLOAD_DIR
    const name = path.basename(String(body.name || ''))
    const fp = path.join(dir, name)
    if (!name || !fs.existsSync(fp)) return sendErr(res, new Error('文件不存在'), 404)
    try {
      fs.unlinkSync(fp)
      log('download', '删除', fp)
      return sendJson(res, { ok: true })
    } catch (e) {
      return sendErr(res, e, 500)
    }
  }

  if (p === '/paths') {
    return sendJson(res, {
      ok: true,
      root: ROOT,
      data: store.paths.DATA_DIR,
      cache: CACHE_DIR,
      download: store.getConfig().downloadDir,
      sources: path.join(ROOT, '音源'),
      log: LOG_DIR,
    })
  }

  return sendErr(res, new Error('接口不存在: ' + url.pathname), 404)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`)
  // 统一允许本地跨域
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Max-Age', '86400')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  if (url.pathname === '/api/proxy') {
    const target = url.searchParams.get('url')
    if (!target) { res.writeHead(400); return res.end('missing url') }
    return proxyStream(req, res, target, Number(url.searchParams.get('px')) || 0)
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(e => {
      log('api', '错误', url.pathname, e.message)
      if (!res.headersSent) sendErr(res, e)
      else try { res.end() } catch (_) {}
    })
    return
  }

  // 移动端竖屏前端：/m 与 /m/xxx
  if (url.pathname === '/m') {
    res.writeHead(302, { Location: '/m/' })
    return res.end()
  }
  if (url.pathname.startsWith('/m/')) {
    return serveStatic(req, res, url.pathname.slice(2) || '/', MOBILE_DIR)
  }

  serveStatic(req, res, url.pathname)
})

server.listen(PORT, HOST, () => {
  log('server', `服务已启动 http://${HOST}:${PORT}`)
  log('server', '移动端前端目录:', MOBILE_DIR)
  if (!fs.existsSync(path.join(MOBILE_DIR, 'index.html'))) {
    log('server', '警告: 移动端目录缺少 index.html，/m 可能 404')
  }
  sourceManager.load().then(() => {
    log('server', '音源加载完成:', sourceManager.list().map(a => a.name).join(', '))
  })
  /* 每日同步调度：启动后预热一次，之后按日期翻页自动刷新（缓存落 数据/每日缓存） */
  try {
    dailySync.startScheduler(txWeb, m => log('daily', m))
  } catch (e) {
    log('daily', '调度启动失败', e.message)
  }
})

server.on('error', e => {
  log('server', '启动失败', e.message)
  process.exit(1)
})

process.on('uncaughtException', e => log('crash', e.stack || e.message))
process.on('unhandledRejection', e => log('crash', (e && e.stack) || String(e)))
