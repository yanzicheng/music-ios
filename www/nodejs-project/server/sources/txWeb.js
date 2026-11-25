'use strict'
/** QQ 音乐 Web 接口封装：歌词 / 排行榜 / 歌单 / 歌单详情 */
const { fetchResp } = require('../net')
const { formatPlayTime, sizeFormate, formatSingerName, decodeName } = require('../util')

const HEADERS = {
  Referer: 'https://y.qq.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',
}

const TOPLIST_IDS = [
  { id: 4, name: '流行指数榜' },
  { id: 26, name: '热歌榜' },
  { id: 27, name: '新歌榜' },
  { id: 62, name: '飙升榜' },
  { id: 58, name: '听歌识曲榜' },
]

function stripJsonp(text) {
  const s = String(text).trim()
  if (s.startsWith('{') || s.startsWith('[')) return JSON.parse(s)
  const m = s.match(/^[\w$.]+\s*\(([\s\S]*)\)\s*;?\s*$/)
  return m ? JSON.parse(m[1]) : JSON.parse(s)
}

function jsonp2json(url, headers = HEADERS) {
  return fetchResp(url, { method: 'get', headers }).then(r => {
    if (typeof r.body === 'string') return stripJsonp(r.body)
    return r.body
  })
}

/** 把 QQ 音乐的歌曲对象统一成内部结构 */
function convert(raw) {
  if (!raw) return null
  const songmid = raw.songmid || raw.mid || ''
  const mediaMid = raw.strMediaMid || raw.media_mid || songmid
  const albumMid = raw.albummid || (raw.album && raw.album.mid) || ''
  const name = decodeName(raw.songname || raw.name || raw.title || '')
  const singers = raw.singer && raw.singer.length ? raw.singer : (raw.singers || [])
  const singer = formatSingerName(singers, 'name')
  const albumName = decodeName(raw.albumname || (raw.album && raw.album.name) || '')
  const duration = Number(raw.interval) || 0
  const types = []
  const _types = {}
  const add = (t, size) => {
    if (!size) return
    types.push({ type: t, size: sizeFormate(size) })
    _types[t] = { size: sizeFormate(size) }
  }
  add('128k', raw.size128)
  add('320k', raw.size320)
  add('flac', raw.sizeflac)
  add('flac24bit', raw.sizehires || raw.size5_1)
  if (!types.length) { types.push({ type: '128k', size: '-' }); _types['128k'] = { size: '-' } }

  const img = albumMid && albumMid !== '空'
    ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`
    : (singers[0] && singers[0].mid ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${singers[0].mid}.jpg` : '')

  return {
    source: 'tx',
    songmid,
    strMediaMid: mediaMid,
    songId: raw.songid || raw.id || '',
    name,
    singer,
    singerList: singers.map(s => ({ id: s.id, mid: s.mid, name: s.name })),
    albumName,
    albumMid,
    albumId: raw.albumid || (raw.album && raw.album.id) || '',
    duration,
    interval: duration ? formatPlayTime(duration) : '',
    img,
    types,
    _types,
    typeUrl: {},
  }
}

/** 歌词（LRC 明文，兼容翻译） */
async function getLyric(songmid) {
  const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(songmid)}&format=json&nobase64=1&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`
  const body = await jsonp2json(url, {
    Referer: 'https://y.qq.com/portal/player.html',
    'User-Agent': HEADERS['User-Agent'],
  })
  const dec = v => {
    if (!v) return ''
    if (/^[A-Za-z0-9+/=\s]+$/.test(v) && !v.includes('[')) {
      try { return Buffer.from(v, 'base64').toString('utf8') } catch (_) { return v }
    }
    return v
  }
  if (body && body.retcode === 0) {
    return { lyric: dec(body.lyric), tlyric: dec(body.trans) }
  }
  return { lyric: '', tlyric: '' }
}

/** 排行榜列表 */
async function getTopLists() {
  const url = 'https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg?format=json&g_tk=5381&inCharset=utf8&outCharset=utf-8&platform=yqq.json&needNewCode=0'
  const body = await jsonp2json(url)
  const list = (body && body.data && body.data.topList) || []
  const prefer = ['热歌榜', '新歌榜', '飙升榜', '流行指数榜', '听歌识曲榜', 'MV榜']
  return list
    .filter(t => prefer.includes(t.topTitle) || t.id)
    .map(t => ({
      id: t.id,
      name: t.topTitle,
      img: t.picUrl,
      listenCount: t.listenCount,
      songs: (t.songList || []).slice(0, 3).map(s => ({ name: s.songname, singer: s.singername })),
    }))
    .sort((a, b) => {
      const ia = prefer.indexOf(a.name); const ib = prefer.indexOf(b.name)
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    })
}

/** 排行榜详情 */
async function getTopListDetail(topId = 26, page = 1, limit = 50) {
  const begin = (page - 1) * limit
  const url = `https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=${topId}&format=json&page=detail&type=top&song_begin=${begin}&song_num=${limit}&g_tk=5381&inCharset=utf8&outCharset=utf-8&platform=yqq.json&needNewCode=0`
  const body = await jsonp2json(url)
  const list = ((body && body.songlist) || []).map(it => convert(it.data)).filter(Boolean)
  return {
    list,
    total: (body && body.total_song_num) || list.length,
    name: (body && body.topinfo && body.topinfo.ListName) || '',
    updateTime: (body && body.update_time) || '',
    source: 'tx',
  }
}

/** musicu 新接口的歌曲对象 → convert 可识别的字段 */
function normalizeV2(s) {
  if (!s) return null
  const f = s.file || {}
  const al = s.album || {}
  return {
    songmid: s.mid || s.songmid || '',
    strMediaMid: f.media_mid || s.mid || '',
    songid: s.id || s.songid || '',
    songname: s.name || s.title || '',
    singer: s.singer || [],
    albumname: al.name || '',
    albummid: al.mid || '',
    albumid: al.id || '',
    interval: s.interval || 0,
    size128: f.size_128mp3 || 0,
    size320: f.size_320mp3 || 0,
    sizeflac: f.size_flac || 0,
    sizehires: f.size_hires || 0,
  }
}

/**
 * 歌单详情（musicu / CgiGetDiss）
 * 旧 fcg 接口对部分老歌单返回 subcode 4000（check privacy error），此接口不受影响
 */
async function getPlaylistV2(disstid) {
  const idNum = Number(disstid)
  if (!idNum) return null
  const payload = {
    comm: { ct: 24, cv: 0, format: 'json', uin: '0' },
    req: {
      module: 'music.srfDissInfo.DissInfo',
      method: 'CgiGetDiss',
      param: { disstid: idNum, dirid: 0, tag: 1, song_begin: 0, song_num: 1000, userinfo: 1, onlysonglist: 0 },
    },
  }
  const resp = await fetchResp('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'post',
    headers: Object.assign({}, HEADERS, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  })
  const body = typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body
  const req = body && body.req
  if (!req || req.code !== 0) return null
  const data = req.data || {}
  const dir = data.dirinfo || {}
  const songs = (data.songlist || []).map(normalizeV2).map(convert).filter(Boolean)
  if (!songs.length) return null
  const creator = dir.creator && (dir.creator.nick || dir.creator.name || dir.creator.hostnick)
  return {
    id: String(dir.id || idNum),
    name: decodeName(dir.title || ''),
    cover: dir.picurl || '',
    creator: decodeName(dir.host_nick || creator || ''),
    desc: decodeName(dir.desc || ''),
    songCount: Number(dir.songnum) || songs.length,
    visitCount: Number(dir.listennum) || 0,
    songs,
    source: 'tx',
  }
}

/** 歌单详情 */
async function getPlaylist(disstid) {
  try {
    const v2 = await getPlaylistV2(disstid)
    if (v2) return v2
  } catch (_) { /* 新接口失败则回落到旧接口 */ }
  const url = `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?disstid=${encodeURIComponent(disstid)}&type=1&json=1&utf8=1&onlysong=0&g_tk=5381&platform=yqq.json&needNewCode=0`
  const body = await jsonp2json(url)
  const cd = body && body.cdlist && body.cdlist[0]
  if (!cd) throw new Error('歌单不存在或不可访问')
  return {
    id: cd.disstid,
    name: decodeName(cd.dissname),
    cover: cd.logo || '',
    creator: decodeName(cd.nickname || ''),
    desc: decodeName(cd.desc || ''),
    songCount: cd.songnum,
    visitCount: cd.visitnum,
    songs: (cd.songlist || []).map(convert).filter(Boolean),
    source: 'tx',
  }
}

/** 推荐歌单：抓 QQ 音乐歌单广场（分类页），拿不到时回落到排行榜 */
async function getRecommend() {
  try {
    const url = 'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?picmid=1&rnd=0.8&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0&categoryId=10000000&sortId=5&sin=0&ein=29'
    const body = await jsonp2json(url)
    const list = (body && body.data && body.data.list) || []
    if (list.length) {
      return list.map(it => ({
        id: it.dissid,
        name: decodeName(it.dissname),
        cover: it.imgurl,
        listenCount: it.listennum,
        creator: decodeName(it.creator && it.creator.name),
      }))
    }
  } catch (_) {}
  return []
}

module.exports = {
  convert,
  getLyric,
  getTopLists,
  getTopListDetail,
  getPlaylist,
  getRecommend,
  TOPLIST_IDS,
}
