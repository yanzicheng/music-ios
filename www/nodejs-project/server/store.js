'use strict'
/** 本地数据存储（全部写入 D:\学习\音乐\数据，绝不写 C 盘） */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.LX_ROOT ? path.resolve(process.env.LX_ROOT) : path.resolve(__dirname, '../..')
const DATA_DIR = path.join(ROOT, '数据')

const FILES = {
  library: path.join(DATA_DIR, 'library.json'),
  history: path.join(DATA_DIR, 'history.json'),
  config: path.join(DATA_DIR, 'config.json'),
}

const DEFAULT_CONFIG = {
  // 2026-11-19 音质整改：默认只要最好的音质（Hi-Res 24bit/FLAC），不再默认 320k
  quality: 'flac24bit',
  volume: 0.8,
  playMode: 'list', // list | single | random
  downloadDir: path.join(ROOT, '下载'),
  // kw 是当前唯一稳定真 24bit 通道，默认优先平台随之改为 kw（tx 仅兜底）
  preferSource: ['kw'],
  // 音效配置（Web Audio 音效链）：随 config.json 持久化到 D:\学习\音乐\数据
  /* v62：音效链与母带默认开启。此处刻意不写 cfgVer / mastering 字段：
     前端 audiofx.js 以「配置里有没有 cfgVer」判定是新版还是老配置，
     老配置（默认就是关闭状态，on:false 不代表用户意图）统一迁移到新默认开启；
     用户在 v62+ 手动关闭母带后会带上 userSet:true，之后不再被覆盖。 */
  audioFx: {
    enabled: true,
    preset: 'original',
    eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 10 段增益 dB：31/62/125/250/500/1k/2k/4k/8k/16k
    width: 0,        // 立体声宽度 0~1
    bass: 0,         // 低音增强 0~1
    smartVolume: false, // 智能音量平衡（压缩器响度均衡）
    fade: 0,         // 淡入淡出秒数 0~5
    rate: 1,         // 播放速度 0.5~2
    customPresets: {}, // 自定义预设 { 名称: { eq, width, bass } }
  },
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return structuredClone(fallback)
    const txt = fs.readFileSync(file, 'utf8')
    if (!txt.trim()) return structuredClone(fallback)
    return JSON.parse(txt)
  } catch (_) {
    return structuredClone(fallback)
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file))
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

const initLibrary = () => ({
  favorites: [],
  playlists: [],
  updatedAt: Date.now(),
})

class Store {
  constructor() {
    // 安卓私有目录异常时不应阻断服务启动，降级为内存态运行
    for (const d of [DATA_DIR, path.join(DATA_DIR, '缓存'), path.join(ROOT, '下载')]) {
      try {
        ensureDir(d)
      } catch (e) {
        console.error('[store] 创建目录失败', d, e.message)
      }
    }
  }

  get paths() {
    return { ROOT, DATA_DIR, ...FILES }
  }

  /* ---------- 配置 ---------- */
  getConfig() {
    const cfg = readJson(FILES.config, DEFAULT_CONFIG)
    const out = Object.assign({}, DEFAULT_CONFIG, cfg)
    // audioFx 是嵌套对象，老版本 config.json 可能缺字段，逐键补齐避免前端取到 undefined
    out.audioFx = Object.assign({}, DEFAULT_CONFIG.audioFx, out.audioFx || {})
    return out
  }

  setConfig(patch) {
    const cfg = Object.assign(this.getConfig(), patch || {})
    if (patch && patch.audioFx) cfg.audioFx = Object.assign({}, DEFAULT_CONFIG.audioFx, patch.audioFx)
    writeJson(FILES.config, cfg)
    return cfg
  }

  /* ---------- 收藏 / 歌单 ---------- */
  getLibrary() {
    const lib = readJson(FILES.library, initLibrary())
    if (!Array.isArray(lib.favorites)) lib.favorites = []
    if (!Array.isArray(lib.playlists)) lib.playlists = []
    return lib
  }

  saveLibrary(lib) {
    lib.updatedAt = Date.now()
    writeJson(FILES.library, lib)
    return lib
  }

  isFavorite(song) {
    const key = songKey(song)
    return this.getLibrary().favorites.some(s => songKey(s) === key)
  }

  addFavorite(song) {
    const lib = this.getLibrary()
    const key = songKey(song)
    if (!lib.favorites.some(s => songKey(s) === key)) {
      lib.favorites.unshift({ ...song, favAt: Date.now() })
    }
    return this.saveLibrary(lib)
  }

  removeFavorite(song) {
    const lib = this.getLibrary()
    const key = songKey(song)
    lib.favorites = lib.favorites.filter(s => songKey(s) !== key)
    return this.saveLibrary(lib)
  }

  createPlaylist(name) {
    const lib = this.getLibrary()
    const pl = {
      id: 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name || '新建歌单',
      songs: [],
      createdAt: Date.now(),
    }
    lib.playlists.unshift(pl)
    this.saveLibrary(lib)
    return pl
  }

  deletePlaylist(id) {
    const lib = this.getLibrary()
    lib.playlists = lib.playlists.filter(p => p.id !== id)
    return this.saveLibrary(lib)
  }

  renamePlaylist(id, name) {
    const lib = this.getLibrary()
    const pl = lib.playlists.find(p => p.id === id)
    if (pl) pl.name = name
    return this.saveLibrary(lib)
  }

  addToPlaylist(id, songs) {
    const lib = this.getLibrary()
    const pl = lib.playlists.find(p => p.id === id)
    if (!pl) throw new Error('歌单不存在')
    const arr = Array.isArray(songs) ? songs : [songs]
    for (const s of arr) {
      if (!pl.songs.some(x => songKey(x) === songKey(s))) pl.songs.push({ ...s, addedAt: Date.now() })
    }
    this.saveLibrary(lib)
    return pl
  }

  removeFromPlaylist(id, song) {
    const lib = this.getLibrary()
    const pl = lib.playlists.find(p => p.id === id)
    if (!pl) throw new Error('歌单不存在')
    const key = songKey(song)
    pl.songs = pl.songs.filter(s => songKey(s) !== key)
    this.saveLibrary(lib)
    return pl
  }

  /* ---------- 播放历史 ---------- */
  getHistory() {
    return readJson(FILES.history, { list: [] }).list || []
  }

  addHistory(song) {
    const data = readJson(FILES.history, { list: [] })
    const list = data.list || []
    const key = songKey(song)
    const idx = list.findIndex(s => songKey(s) === key)
    if (idx > -1) list.splice(idx, 1)
    list.unshift({ ...song, playedAt: Date.now() })
    data.list = list.slice(0, 500)
    writeJson(FILES.history, data)
    return data.list
  }

  clearHistory() {
    writeJson(FILES.history, { list: [] })
    return []
  }
}

function songKey(song) {
  return `${song.source || 'tx'}_${song.songmid || song.songId || song.id || song.name}`
}

module.exports = { Store, DATA_DIR, ROOT, songKey }
