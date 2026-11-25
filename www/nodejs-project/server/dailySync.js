/* ===========================================================
   每日自动同步（排行榜 / 新歌 / 推荐歌单）
   - 缓存落盘：数据/每日缓存/daily-YYYY-MM-DD.json（严禁写 C 盘）
   - 当日缓存存在即直接命中，不重复抓取
   - 抓取失败时降级返回最近一次成功缓存（无网也能出内容）
   - 后台调度：服务启动后 5 秒预热一次，之后每 30 分钟检查日期是否翻页
   =========================================================== */
const fs = require('node:fs')
const path = require('node:path')
const { DATA_DIR } = require('./store')

const CACHE_DIR = path.join(DATA_DIR, '每日缓存')
const KEEP_DAYS = 7
const TICK_MS = 30 * 60 * 1000

/* 需要同步的榜单（按名称匹配，取不到则回落前三个榜） */
const WANT_RANKS = ['新歌榜', '热歌榜', '飙升榜']
const SONG_LIMIT = 60

let building = null
let lastError = ''

function pad2(n) { return n < 10 ? '0' + n : String(n) }

/** 本地日期键 YYYY-MM-DD（按设备本地时区，避免 UTC 跨日错位） */
function dateKey(d) {
  const t = d || new Date()
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate())
}

function fileOf(key) { return path.join(CACHE_DIR, 'daily-' + key + '.json') }

function ensureDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }) } catch (_) {}
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { return null }
}

function writeJson(file, obj) {
  ensureDir()
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8')
  fs.renameSync(tmp, file)
}

/** 清理过期缓存，只保留最近 KEEP_DAYS 天 */
function prune() {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
    while (files.length > KEEP_DAYS) {
      const f = files.shift()
      try { fs.unlinkSync(path.join(CACHE_DIR, f)) } catch (_) {}
    }
  } catch (_) {}
}

/** 最近一次成功缓存（降级用） */
function latestCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
    for (let i = files.length - 1; i >= 0; i--) {
      const j = readJson(path.join(CACHE_DIR, files[i]))
      if (j && ((j.ranks && j.ranks.length) || (j.newSongs && j.newSongs.length))) {
        return Object.assign({ staleSource: files[i] }, j)
      }
    }
  } catch (_) {}
  return null
}

/** 从歌曲集合里聚合唱手（供「歌手」分类使用） */
function collectSingers(groups) {
  const map = new Map()
  const push = s => {
    const name = String((s && (s.singer || s.name)) || '').trim()
    if (!name || name.length > 20) return
    const it = map.get(name) || { name: name, count: 0, song: null }
    it.count++
    if (!it.song && s && s.img) it.song = { name: s.name, singer: s.singer, songmid: s.songmid, img: s.img, source: s.source }
    map.set(name, it)
  }
  const list = []
  // 歌手拆分：一首歌可能有多个歌手（/ & 、,）
  const each = s => {
    const raw = String((s && s.singer) || '')
    const parts = raw.split(/[\/&、,，·]/).map(x => x.trim()).filter(Boolean)
    if (!parts.length) return
    for (const p of parts) {
      const it = map.get(p) || { name: p, count: 0, song: null }
      it.count++
      if (!it.song && s && s.img) it.song = { name: s.name, singer: s.singer, songmid: s.songmid, img: s.img, source: s.source }
      map.set(p, it)
    }
  }
  for (const g of groups) for (const s of (g || [])) each(s)
  for (const v of map.values()) list.push(v)
  list.sort((a, b) => b.count - a.count)
  return list.slice(0, 120)
}

/** 真正抓取并组装当日数据 */
async function build(txWeb, log) {
  const data = {
    date: dateKey(),
    updatedAt: new Date().toISOString(),
    toplists: [],
    ranks: [],
    newSongs: [],
    hotSongs: [],
    recommend: [],
    singers: [],
  }

  try {
    data.toplists = await txWeb.getTopLists()
  } catch (e) {
    if (log) log('daily', '排行榜列表同步失败', e.message)
  }

  // 推荐歌单
  try {
    data.recommend = await txWeb.getRecommend()
  } catch (e) {
    if (log) log('daily', '推荐歌单同步失败', e.message)
  }

  // 榜单明细：按名称优先，其次取前三个榜
  const all = Array.isArray(data.toplists) ? data.toplists.slice() : []
  const picked = []
  for (const name of WANT_RANKS) {
    const hit = all.find(t => t && String(t.name || '').indexOf(name) >= 0)
    if (hit) picked.push(hit)
  }
  for (const t of all.slice(0, 3)) {
    if (!picked.some(x => x.id === t.id)) picked.push(t)
  }

  for (const t of picked.slice(0, 4)) {
    try {
      const r = await txWeb.getTopListDetail(t.id, 1, SONG_LIMIT)
      const entry = {
        id: t.id,
        name: (r && r.name) || t.name,
        updateTime: (r && r.updateTime) || '',
        img: t.img || '',
        songs: (r && r.list) || [],
      }
      data.ranks.push(entry)
      if (/新歌/.test(entry.name) && !data.newSongs.length) data.newSongs = entry.songs
      if (/热歌|飙升/.test(entry.name) && !data.hotSongs.length) data.hotSongs = entry.songs
    } catch (e) {
      if (log) log('daily', '榜单同步失败 #' + t.id, e.message)
    }
  }
  if (!data.newSongs.length && data.hotSongs.length) data.newSongs = data.hotSongs.slice(0, SONG_LIMIT)
  if (!data.hotSongs.length && data.newSongs.length) data.hotSongs = data.newSongs.slice(0, SONG_LIMIT)

  data.singers = collectSingers([data.newSongs, data.hotSongs].concat(data.ranks.map(r => r.songs || [])))
  data.counts = {
    ranks: data.ranks.length,
    newSongs: data.newSongs.length,
    hotSongs: data.hotSongs.length,
    recommend: data.recommend.length,
    singers: data.singers.length,
  }
  return data
}

/**
 * 取当日数据（前端 /api/daily 入口）
 * force=true 时强制重抓；抓取失败自动降级到最近一次缓存
 */
async function getDaily(txWeb, opts) {
  const force = !!(opts && opts.force)
  const log = (opts && opts.log) || null
  const key = dateKey()
  const file = fileOf(key)

  if (!force) {
    const hit = readJson(file)
    if (hit && ((hit.ranks && hit.ranks.length) || (hit.newSongs && hit.newSongs.length))) {
      return Object.assign({ cached: true, cacheFile: file }, hit)
    }
  }

  if (building) {
    try { return Object.assign({ cached: false, joined: true }, await building) } catch (_) {}
  }

  building = (async () => {
    const data = await build(txWeb, log)
    writeJson(file, data)
    prune()
    return { cached: false, cacheFile: file, ...data }
  })()

  try {
    const r = await building
    lastError = ''
    return r
  } catch (e) {
    lastError = e.message
    const old = latestCache()
    if (old) {
      if (log) log('daily', '当日同步失败，降级旧缓存', old.staleSource + '：' + e.message)
      return Object.assign({ cached: true, degraded: true, degradeReason: e.message, cacheFile: fileOf(old.staleSource.replace(/^daily-|\.json$/g, '')) }, old)
    }
    throw e
  } finally {
    building = null
  }
}

/** 后台调度：日期翻页后自动同步一次 */
function startScheduler(txWeb, log) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const key = dateKey()
      if (fs.existsSync(fileOf(key))) return
      const r = await getDaily(txWeb, { force: true, log: log })
      if (log) log('daily', '每日同步完成', key + '（' + JSON.stringify((r && r.counts) || {}) + '）')
    } catch (e) {
      if (log) log('daily', '每日同步失败', e.message)
    } finally {
      running = false
    }
  }
  setTimeout(tick, 5000)
  const timer = setInterval(tick, TICK_MS)
  if (timer.unref) timer.unref()
  return { tick: tick, stop: () => clearInterval(timer) }
}

module.exports = { getDaily, startScheduler, dateKey, CACHE_DIR, latestCache, lastErrorInfo: () => lastError }
