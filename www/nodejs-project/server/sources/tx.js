'use strict'
/** QQ 音乐搜索（移植自 lx-music-desktop），依赖 net.js + util.js */
const crypto = require('node:crypto')
const { fetchResp } = require('../net')
const { formatPlayTime, sizeFormate, formatSingerName } = require('../util')

/* ---------- zzcSign 签名 ---------- */
const PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19]
const PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5]
const SCRAMBLE_VALUES = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179]

const pickHashByIdx = (hash, indexes) => indexes.map(idx => hash[idx]).join('')

function zzcSign(text) {
  const hash = crypto.createHash('sha1').update(text).digest('hex')
  const part1 = pickHashByIdx(hash, PART_1_INDEXES)
  const part2 = pickHashByIdx(hash, PART_2_INDEXES)
  const part3 = SCRAMBLE_VALUES.map((v, i) => v ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16))
  const b64Part = Buffer.from(part3).toString('base64').replace(/[\\/+=]/g, '')
  return `zzc${part1}${b64Part}${part2}`.toLowerCase()
}

async function signRequest(data) {
  const sign = zzcSign(JSON.stringify(data))
  return fetchResp(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`, {
    method: 'post',
    headers: { 'User-Agent': 'QQMusic 14090508(android 12)' },
    body: data,
    timeout: 15000,
  })
}

/* ---------- 搜索 ---------- */
function getSearchId() {
  let guid = ''
  for (let i = 0; i < 32; i++) guid += Math.floor(Math.random() * 16).toString(16)
  return guid.toUpperCase() + String(Math.floor(Math.random() * 100000)).padStart(5, '0')
}

async function musicSearchRequest(str, page, limit) {
  const payload = {
    comm: {
      _channelid: '0',
      _os_version: '6.2.9200-2',
      ct: '19',
      cv: '2151',
      guid: '1F70E520B2EAA7D25E11760783C53CA9',
      patch: '118',
      psrf_access_token_expiresAt: 0,
      psrf_qqaccess_token: '',
      psrf_qqopenid: '',
      psrf_qqunionid: '',
      tmeAppID: 'qqmusic',
      tmeLoginType: 0,
      uin: '0',
      wid: '7223299733393904640',
    },
    'music.search.SearchCgiService': {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: {
        grp: 1,
        num_per_page: limit,
        page_num: page,
        query: str,
        remoteplace: 'txt.newclient.top',
        search_type: 0,
        searchid: getSearchId(),
      },
    },
  }
  const resp = await signRequest(payload)
  const body = resp.body || {}
  const req = body['music.search.SearchCgiService'] ?? body.req
  if (!req || body.code !== 0 || req.code !== 0) {
    throw new Error('QQ音乐搜索失败: ' + JSON.stringify(body).slice(0, 200))
  }
  return req.data
}

function handleResult(rawList) {
  if (!Array.isArray(rawList)) return []
  const list = []
  for (const item of rawList) {
    if (!item.file || !item.file.media_mid) continue
    const file = item.file
    const types = []
    const _types = {}
    const addType = (t, size) => {
      const s = sizeFormate(size)
      types.push({ type: t, size: s })
      _types[t] = { size: s }
    }
    if (file.size_128mp3) addType('128k', file.size_128mp3)
    if (file.size_320mp3) addType('320k', file.size_320mp3)
    if (file.size_flac) addType('flac', file.size_flac)
    if (file.size_hires) addType('flac24bit', file.size_hires)

    const albumId = item.album && item.album.mid ? item.album.mid : ''
    const albumName = item.album ? item.album.name : ''
    list.push({
      singer: formatSingerName(item.singer, 'name'),
      name: item.title || item.name,
      albumName,
      albumId,
      source: 'tx',
      interval: item.interval ? formatPlayTime(item.interval) : null,
      songId: item.id,
      albumMid: albumId,
      strMediaMid: file.media_mid,
      songmid: item.mid,
      img: (!albumId || albumId === '空')
        ? (item.singer && item.singer.length ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${item.singer[0].mid}.jpg` : '')
        : `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg`,
      types,
      _types,
      typeUrl: {},
    })
  }
  return list
}

async function search(str, page = 1, limit = 30) {
  const data = await musicSearchRequest(str, page, limit)
  const songList = (data && data.body && data.body.song && data.body.song.list) || []
  const list = handleResult(songList)
  const total = (data && data.meta && data.meta.sum) || list.length
  return {
    list,
    total,
    limit,
    page,
    allPage: Math.ceil(total / limit) || 1,
    source: 'tx',
    sourceName: 'QQ音乐',
  }
}

module.exports = {
  id: 'tx',
  name: 'QQ音乐',
  search,
  zzcSign,
}
