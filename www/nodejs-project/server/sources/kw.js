'use strict'
/**
 * 酷我音乐（kw）搜索 / 歌词 / 封面
 * 只负责"找歌"，播放地址由 音源脚本（洛雪格式）提供
 */
const { httpText } = require('../net')

const SEARCH_API = 'http://search.kuwo.cn/r.s'
const H5_INFO = 'http://m.kuwo.cn/newh5/singles/songinfoandlrc'

const HDR = {
  Referer: 'http://www.kuwo.cn/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  Cookie: 'kw_token=ABCDEFGHIJ',
}

function fmtDur(sec) {
  const s = Number(sec) || 0
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

function coverUrl(item) {
  const short = item.web_albumpic_short || item.hts_MVPIC || ''
  if (short && /^https?:/.test(short)) return short.replace(/\/\d+\//, '/500/')
  if (short) return 'https://img4.kuwo.cn/star/albumcover/' + short
  return ''
}

/** 洛雪兼容的歌曲结构 */
function toSong(item) {
  const formats = String(item.FORMATS || '')
  const types = []
  if (/FLAC|AL/.test(formats)) types.push({ type: 'flac', size: '' })
  if (/MP3H|MP3320|MP3/.test(formats)) types.push({ type: '320k', size: '' })
  types.push({ type: '128k', size: '' })
  return {
    source: 'kw',
    songmid: String(item.MUSICRID || '').replace(/^MUSIC_/, ''),
    name: decodeName(item.SONGNAME),
    singer: decodeName(item.ARTIST),
    albumName: decodeName(item.ALBUM),
    albumId: item.ALBUMID || '',
    interval: fmtDur(item.DURATION),
    img: coverUrl(item),
    types,
    _raw: { rid: String(item.MUSICRID || '').replace(/^MUSIC_/, ''), dcopyright: item.dcopyright || '' },
  }
}

function decodeName(s) {
  return String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim()
}

/**
 * 酷我接口返回单引号伪 JSON，这里做确定性转换（不用 eval，避免注入）
 * - 字符串界符 ' → "
 * - 字符串内的 " → \"
 * - 字符串内的裸换行 → \n
 */
function looseJsonParse(txt) {
  const src = String(txt)
  let out = ''
  let inStr = false
  let quote = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (c === '\\') { out += c + (src[i + 1] === undefined ? '' : src[i + 1]); i++; continue }
      if (c === quote) { out += '"'; inStr = false; continue }
      if (c === '"') { out += '\\"'; continue }
      if (c === '\n') { out += '\\n'; continue }
      if (c === '\r') continue
      out += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; out += '"'; inStr = true; continue }
    out += c
  }
  return JSON.parse(out)
}

async function search(keyword, page = 1, limit = 30) {
  const url = SEARCH_API + '?' + [
    'client=kt',
    'all=' + encodeURIComponent(keyword),
    'pn=' + (page - 1),
    'rn=' + limit,
    'uid=794762570',
    'ver=kwplayer_ar_9.2.2.1',
    'vipver=1',
    'show_copyright_off=1',
    'newver=1',
    'ft=music',
    'cluster=0',
    'strategy=2012',
    'encoding=utf8',
    'rformat=json',
    'vermerge=1',
    'mobi=1',
    'issubtitle=1',
  ].join('&')
  const txt = await httpText(url, { headers: HDR, timeout: 15000 })
  let json
  try {
    json = looseJsonParse(txt)
  } catch (e) {
    throw new Error('酷我搜索返回格式异常: ' + txt.slice(0, 120))
  }
  const list = (json.abslist || []).map(toSong).filter(s => s.songmid)
  return { list, total: Number(json.TOTAL || list.length), page, limit }
}

/** 秒数转标准 LRC 时间标签 [mm:ss.xx] */
function toLrcTime(sec) {
  const n = Number(sec)
  if (!isFinite(n) || n < 0) return '[00:00.00]'
  const m = Math.floor(n / 60)
  const s = n - m * 60
  const ss = s.toFixed(2).padStart(5, '0')
  return `[${String(m).padStart(2, '0')}:${ss}]`
}

/** 单次拉取酷我歌词（含 3 次重试，接口对高频请求会返回“音乐查询失败”） */
async function fetchLyricOnce(rid) {
  const url = `${H5_INFO}?musicId=${encodeURIComponent(rid)}&httpsStatus=1`
  const txt = await httpText(url, {
    headers: Object.assign({}, HDR, { Referer: 'http://m.kuwo.cn/' }),
    timeout: 15000,
  })
  let json
  try { json = JSON.parse(txt) } catch (_) { return [] }
  if (json && json.status && Number(json.status) !== 200) return []
  return (json.data && json.data.lrclist) || []
}

/** 酷我歌词：返回 { lyric, tlyric } */
async function getLyric(song) {
  const rid = song.songmid || (song._raw && song._raw.rid)
  if (!rid) return { lyric: '', tlyric: '' }
  let lrclist = []
  for (let i = 0; i < 3 && !lrclist.length; i++) {
    if (i) await new Promise(r => setTimeout(r, 400 * i))
    try { lrclist = await fetchLyricOnce(rid) } catch (_) { lrclist = [] }
  }
  if (!lrclist.length) return { lyric: '', tlyric: '' }
  const lyric = lrclist.map(x => `${toLrcTime(x.time)}${x.lineLyric || ''}`).join('\n')
  return { lyric, tlyric: '' }
}

/** 酷我歌曲详情（补封面/时长） */
async function getSongInfo(rid) {
  const url = `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(rid)}&httpsStatus=1`
  const txt = await httpText(url, { headers: HDR, timeout: 15000 })
  try {
    const j = JSON.parse(txt)
    const d = j.data && j.data.songinfo
    if (!d) return null
    return { name: d.songName, singer: d.artist, albumName: d.album, img: d.pic, interval: fmtDur(d.songTimeMinutes ? 0 : 0) }
  } catch (_) { return null }
}

module.exports = { search, getLyric, getSongInfo, toSong }
