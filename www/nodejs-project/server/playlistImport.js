'use strict'
/**
 * 外部歌单导入（QQ音乐 / 网易云 / 酷狗）
 *
 * 实测结论（2026-11 联网验证，均返回真实数据）：
 *  QQ音乐   musicu.fcg  music.srfDissInfo.DissInfo / CgiGetDiss
 *            → dirinfo{title,picurl(600可用),songnum,desc} + songlist[{name,mid,singer[],album{mid,name},interval}]
 *            分页 60/页，翻页看 hasmore；旧 fcg_ucc_getcdinfo 已失效（cdlist 空）
 *  网易云   music.163.com/api/v6/playlist/detail?id=&n=1000&s=8
 *            → playlist{name,coverImgUrl,trackCount,tracks[{name,ar[{name}],al{name,picUrl},dt(ms)}]}
 *            单次最多返回 1000 首，超出部分接口不返回（导入时如实提示）
 *  酷狗     mobilecdn.kugou.com/api/v3/special/info?specialid=
 *            → data{specialname,imgurl(带 {size} 占位),songcount,nickname}
 *           mobilecdn.kugou.com/api/v3/special/song?specialid=&page=&pagesize=100
 *            → data{total, info[{filename:"歌手 - 歌名", hash, album_id, duration(秒)}]}
 *            酷狗接口不返回单曲封面，歌曲封面统一用歌单封面兜底
 */
const { rawRequest } = require('./net')
const { upgradeCoverUrl } = require('./cover')

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const UA_M = 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'

const MAX_SONGS = 2000

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
}

async function getJson(url, headers, bodyStr) {
  const resp = await rawRequest(url, {
    method: bodyStr ? 'post' : 'get',
    headers: Object.assign({ 'User-Agent': UA_PC }, headers || {}),
    body: bodyStr,
    timeout: 20000,
  })
  if (typeof resp.body === 'string') {
    try { return JSON.parse(resp.body) } catch (_) { throw new Error('接口返回非 JSON 数据') }
  }
  return resp.body
}

/* ---------------- 链接 / ID 解析 ---------------- */

const PLATFORM_ALIAS = {
  qq: 'qq', qqmusic: 'qq', tx: 'qq', 'QQ音乐': 'qq', 'qq音乐': 'qq',
  wy: 'wy', netease: 'wy', '163': 'wy', '网易云': 'wy', '网易云音乐': 'wy',
  kg: 'kg', kugou: 'kg', '酷狗': 'kg', '酷狗音乐': 'kg',
}

/**
 * 从用户粘贴的内容里识别平台与歌单 ID
 * @returns {{platform:string,id:string}|null} 未显式给出平台时 platform 为 ''（后续自动探测）
 */
function parseImportInput(input) {
  let s = decodeEntities(String(input || '')).trim()
  if (!s) return null
  s = s.replace(/[\u200b-\u200f\s]+/g, '')

  // 形如 qq:7011264340 / 网易云:3778678
  let m = s.match(/^([A-Za-z\u4e00-\u9fa5]+)\s*[:：]\s*(\d{4,})$/)
  if (m) {
    const key = m[1].toLowerCase()
    const platform = PLATFORM_ALIAS[key] || PLATFORM_ALIAS[m[1]] || ''
    if (platform) return { platform, id: m[2] }
  }

  // 纯数字 ID：平台未知，交给自动探测
  if (/^\d{4,}$/.test(s)) return { platform: '', id: s }

  // QQ音乐（链接里 disstid / playlist id / taoge id）
  m = s.match(/(?:y\.qq\.com|qq\.com)/i) && (
    s.match(/disstid[=\/](\d+)/i) ||
    s.match(/playlist\/(\d+)/i) ||
    s.match(/[?&]id=(\d{4,})/i) ||
    s.match(/\/(\d{5,})(?:\.html|\?|$)/)
  )
  if (m) return { platform: 'qq', id: m[1] }

  // 网易云（含 163cn.tv 短链：拿不到 id 时抛可读错误）
  if (/music\.163\.com|y\.music\.163\.com/i.test(s)) {
    m = s.match(/[?&#]id=(\d+)/i) || s.match(/playlist\/(\d+)/i) || s.match(/discover\/toplist\/(\d+)/i)
    if (m) return { platform: 'wy', id: m[1] }
  }
  if (/163cn\.tv/i.test(s)) return { platform: 'wy', id: '', shortUrl: s }

  // 酷狗（special/single、plist/list、specialid）
  if (/kugou\.com/i.test(s)) {
    m = s.match(/special\/single\/(\d+)/i) || s.match(/plist\/list\/(\d+)/i) || s.match(/specialid[=\/](\d+)/i) ||
      s.match(/[?&]id=(\d+)/i) || s.match(/\/(\d{5,})(?:\.html|\?|$)/)
    if (m) return { platform: 'kg', id: m[1] }
  }

  // 兜底：链接里最后一个 5 位以上数字
  m = s.match(/[=\/](\d{5,})/)
  if (m) return { platform: '', id: m[1] }
  // 纯文本歌单兜底：每行「歌名 - 歌手」或「歌名 歌手」
  if (/\n/.test(String(input))) return { platform: 'text', id: '', text: String(input) }
  return null
}

/* ---------------- QQ 音乐 ---------------- */

async function fetchQQ(id) {
  const payload = (begin) => JSON.stringify({
    comm: { ct: 24, cv: 0 },
    req: {
      module: 'music.srfDissInfo.DissInfo',
      method: 'CgiGetDiss',
      param: { disstid: Number(id), dirid: 0, tag: 1, song_begin: begin, song_num: 60, userinfo: 1 },
    },
  })
  const first = await getJson('https://u6.y.qq.com/cgi-bin/musicu.fcg', {
    Referer: 'https://y.qq.com/', Origin: 'https://y.qq.com', 'Content-Type': 'application/json',
  }, payload(0))
  const d = first && first.req && first.req.data
  if (!d || !Array.isArray(d.songlist)) {
    const msg = (first && first.req && first.req.data && first.req.data.msg) || (first && first.req && first.req.msg) || ''
    throw new Error('QQ音乐歌单不存在或已设为私密' + (msg ? '（' + msg + '）' : ''))
  }
  const dir = d.dirinfo || {}
  const songs = []
  let hasmore = !!d.hasmore
  const pushList = list => {
    for (const it of list || []) {
      const albumMid = (it.album && it.album.mid) || ''
      const singerNames = (it.singer || []).map(x => x.name).filter(Boolean)
      songs.push({
        name: decodeEntities(it.name || it.title || ''),
        singer: singerNames.join(' / '),
        albumName: decodeEntities((it.album && it.album.name) || ''),
        duration: Number(it.interval) || 0,
        img: albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg` : '',
        externalId: it.mid || '',
      })
    }
  }
  pushList(d.songlist)

  let guard = 0
  while (hasmore && songs.length < MAX_SONGS && guard < 40) {
    guard++
    const next = await getJson('https://u6.y.qq.com/cgi-bin/musicu.fcg', {
      Referer: 'https://y.qq.com/', Origin: 'https://y.qq.com', 'Content-Type': 'application/json',
    }, payload(songs.length))
    const nd = next && next.req && next.req.data
    if (!nd || !Array.isArray(nd.songlist) || !nd.songlist.length) break
    pushList(nd.songlist)
    hasmore = !!nd.hasmore
  }

  return {
    platform: 'qq',
    id: String(id),
    name: decodeEntities(dir.title || 'QQ音乐歌单'),
    cover: upgradeCoverUrl(dir.picurl || '', 600),
    creator: decodeEntities((dir.hostnick || dir.nickname || '')),
    desc: decodeEntities(dir.desc || ''),
    songCount: Number(dir.songnum) || songs.length,
    songs,
  }
}

/* ---------------- 网易云 ---------------- */

async function fetchWY(id) {
  const body = await getJson(`https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(id)}&n=1000&s=8`, {
    Referer: 'https://music.163.com/',
  })
  const pl = body && body.playlist
  if (!pl) {
    if (body && body.code === 404) throw new Error('网易云歌单不存在或已被删除')
    throw new Error('网易云歌单读取失败' + (body && body.msg ? '（' + body.msg + '）' : ''))
  }
  const songs = (pl.tracks || []).map(t => {
    const pic = (t.al && t.al.picUrl) || ''
    return {
      name: decodeEntities(t.name || ''),
      singer: (t.ar || []).map(a => a.name).filter(Boolean).join(' / '),
      albumName: decodeEntities((t.al && t.al.name) || ''),
      duration: Math.round((Number(t.dt) || 0) / 1000),
      img: pic ? upgradeCoverUrl(pic, 600) : '',
      externalId: String(t.id || ''),
    }
  }).filter(s => s.name)
  const total = Number(pl.trackCount) || songs.length
  return {
    platform: 'wy',
    id: String(id),
    name: decodeEntities(pl.name || '网易云歌单'),
    cover: upgradeCoverUrl(pl.coverImgUrl || '', 600),
    creator: decodeEntities((pl.creator && pl.creator.nickname) || ''),
    desc: decodeEntities(pl.description || ''),
    songCount: total,
    songs,
    truncated: songs.length < total ? `网易云接口单次最多返回 ${songs.length} 首（歌单共 ${total} 首）` : '',
  }
}

/* ---------------- 酷狗 ---------------- */

async function fetchKG(id) {
  const info = await getJson(`https://mobilecdn.kugou.com/api/v3/special/info?specialid=${encodeURIComponent(id)}&version=8000`, {
    'User-Agent': UA_M, Referer: 'https://m.kugou.com/',
  })
  const d = info && info.data
  if (!d) throw new Error('酷狗歌单不存在或已下架')
  const cover = upgradeCoverUrl(String(d.imgurl || '').replace('{size}', '480'), 600)
  const total = Number(d.songcount) || 0
  const songs = []
  let page = 1
  let guard = 0
  while (songs.length < Math.min(total || 300, MAX_SONGS) && guard < 40) {
    guard++
    const r = await getJson(`http://mobilecdn.kugou.com/api/v3/special/song?specialid=${encodeURIComponent(id)}&page=${page}&pagesize=100&version=8000&plat=0`, {
      'User-Agent': UA_M, Referer: 'https://m.kugou.com/',
    })
    const info2 = r && r.data && r.data.info
    if (!Array.isArray(info2) || !info2.length) break
    for (const it of info2) {
      const fn = decodeEntities(it.filename || '')
      const idx = fn.indexOf(' - ')
      const singer = idx > -1 ? fn.slice(0, idx) : ''
      const name = idx > -1 ? fn.slice(idx + 3) : fn
      if (!name) continue
      songs.push({
        name,
        singer,
        albumName: decodeEntities(it.album_name || ''),
        duration: Number(it.duration) || 0,
        img: cover,
        externalId: it.hash || '',
      })
    }
    if (info2.length < 100) break
    page++
  }
  return {
    platform: 'kg',
    id: String(id),
    name: decodeEntities(d.specialname || '酷狗歌单'),
    cover,
    creator: decodeEntities(d.nickname || ''),
    desc: '',
    songCount: total || songs.length,
    songs,
    truncated: total && songs.length < total ? `酷狗接口仅返回 ${songs.length} / ${total} 首` : '',
  }
}

/* ---------------- 纯文本歌单兜底 ---------------- */

function parsePlainText(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const songs = []
  for (const line of lines) {
    const clean = line.replace(/^\d+[.、)\s]+/, '').trim()
    if (!clean) continue
    const m = clean.match(/^(.+?)\s*[-–—|]\s*(.+)$/)
    if (m) songs.push({ name: m[1].trim(), singer: m[2].trim(), albumName: '', duration: 0, img: '', externalId: '' })
    else songs.push({ name: clean, singer: '', albumName: '', duration: 0, img: '', externalId: '' })
  }
  return {
    platform: 'text',
    id: '',
    name: '导入的文本歌单',
    cover: '',
    creator: '',
    desc: '',
    songCount: songs.length,
    songs,
  }
}

/* ---------------- 对外入口 ---------------- */

async function inspect(input) {
  const parsed = parseImportInput(input)
  if (!parsed) {
    throw new Error('无法识别歌单链接或 ID。支持：QQ音乐（y.qq.com/n/ryqq/playlist/…）、网易云（music.163.com/#/playlist?id=…）、酷狗（kugou.com/yy/special/single/….html），也可直接粘贴歌单 ID 或纯文本歌单')
  }
  if (parsed.platform === 'text') return parsePlainText(parsed.text || input)
  if (parsed.platform === 'wy' && !parsed.id) {
    throw new Error('网易云短链（163cn.tv）需要展开后才能识别，请在浏览器打开后复制完整链接（含 id=…）再导入')
  }
  if (!parsed.id) throw new Error('没有在链接里找到歌单 ID，请确认复制的是歌单页面链接')

  if (parsed.platform === 'qq') return fetchQQ(parsed.id)
  if (parsed.platform === 'wy') return fetchWY(parsed.id)
  if (parsed.platform === 'kg') return fetchKG(parsed.id)

  // 平台未知：按 QQ → 网易云 → 酷狗 顺序探测
  const errors = []
  for (const fn of [fetchQQ, fetchWY, fetchKG]) {
    try {
      const r = await fn(parsed.id)
      if (r && r.songs.length) return r
      errors.push((r && r.platform) + ': 歌单为空')
    } catch (e) { errors.push(e.message) }
  }
  throw new Error('三个平台都没有这个歌单 ID，请确认 ID 是否正确（' + errors.join('；') + '）')
}

/** 归一化为内部歌曲结构，用于落本地歌单 */
function toLocalSong(s, meta, seq) {
  return {
    source: 'import',
    songmid: 'imp_' + (meta.platform || 'x') + '_' + (s.externalId || seq),
    songId: s.externalId || '',
    name: s.name,
    singer: s.singer || '',
    albumName: s.albumName || '',
    interval: s.duration ? formatDuration(s.duration) : '',
    duration: s.duration || 0,
    img: s.img || meta.cover || '',
    types: [{ type: '128k', size: '-' }],
    importPlatform: meta.platform,
    importPlaylist: meta.name,
    importSeq: seq,
    importExternalId: s.externalId || '',
  }
}

function formatDuration(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0))
  const m = Math.floor(n / 60)
  const s = n % 60
  return m + ':' + String(s).padStart(2, '0')
}

module.exports = { inspect, parseImportInput, toLocalSong, fetchQQ, fetchWY, fetchKG }
