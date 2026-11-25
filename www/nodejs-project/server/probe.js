'use strict'
/**
 * 播放地址可用性探测
 * 目的：第三方音源经常返回"试听片段"或 HTML 错误页，必须校验后再交给播放器，
 * 否则表现为"能播但只有几十秒"或"直接报错"。
 */
const { rawRequest } = require('./net')

// 各档位大致字节率（用于按时长估算最小合理体积）
const RATE = {
  '128k': 14 * 1024,
  '320k': 36 * 1024,
  flac: 55 * 1024,
  flac24bit: 100 * 1024,
}

const AUDIO_CT = /^(audio\/|application\/(octet-stream|ogg|x-flac))/i

function magicInfo(buf) {
  if (!buf || buf.length < 4) return { magic: '', audio: false }
  const h = buf.slice(0, 4).toString('latin1')
  let audio = false
  if (h === 'fLaC') audio = true
  else if (h === 'OggS') audio = true
  else if (h.startsWith('ID3')) audio = true
  else if (h.startsWith('RIFF')) audio = true
  else if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) audio = true // MPEG/AAC 帧同步
  else if (buf.slice(4, 8).toString('latin1') === 'ftyp') audio = true // m4a
  return { magic: h, audio }
}

/** 解析 FLAC STREAMINFO，返回真实采样率 / 声道 / 位深 */
function flacInfo(buf) {
  if (!buf || buf.length < 26 || buf.slice(0, 4).toString('latin1') !== 'fLaC') return null
  // 'fLaC' + 4 字节块头 + STREAMINFO 前 10 字节，其后 8 字节打包 sampleRate/channels/bits/totalSamples
  const o = 18
  const hi = buf.readUInt32BE(o)
  const lo = buf.readUInt32BE(o + 4)
  const sampleRate = Math.floor(hi / 4096) // hi >> 12
  const channels = ((hi >> 9) & 0x07) + 1
  const bitsPerSample = ((hi >> 4) & 0x1f) + 1
  const totalSamples = (hi & 0x0f) * 4294967296 + lo
  return { sampleRate, channels, bitsPerSample, totalSamples }
}

/**
 * @param {string} url
 * @param {{quality?:string, interval?:number, referer?:string, timeout?:number}} opts
 * @returns {Promise<{ok:boolean, reason?:string, total:number, contentType:string, magic:string}>}
 */
async function probePlayable(url, opts = {}) {
  const quality = opts.quality || '128k'
  const seconds = Number(opts.interval) > 0 ? Number(opts.interval) : 0
  const needBytes = seconds
    ? Math.max(300 * 1024, seconds * (RATE[quality] || RATE['128k']) * 0.5)
    : 700 * 1024

  let resp
  try {
    resp = await rawRequest(url, {
      method: 'get',
      headers: {
        Range: 'bytes=0-8191',
        Referer: opts.referer || 'https://www.kuwo.cn/',
        Accept: '*/*',
      },
      /* v3.19：探测只是取 8KB 首包校验魔数与体积，正常几十毫秒就回。
         旧值 12s 会让一个卡住的直链把整轮解析拖到超时（实测有探测 12s 才超时的音源），
         这里压到 3.2s，卡住的直接判不可用、立刻换下一个音源。 */
      timeout: opts.timeout || 3200,
    })
  } catch (e) {
    return { ok: false, reason: 'NET: ' + e.message, total: 0, contentType: '', magic: '' }
  }

  const status = resp.statusCode
  if (status >= 400) return { ok: false, reason: 'HTTP ' + status, total: 0, contentType: '', magic: '' }

  const ct = String(resp.headers['content-type'] || '').split(';')[0]
  const cr = String(resp.headers['content-range'] || '')
  let total = Number((cr.split('/')[1] || '').trim()) || 0
  if (!total) total = Number(resp.headers['content-length'] || resp.bytes || 0)

  if (/^text\//i.test(ct)) return { ok: false, reason: '返回 HTML/文本而非音频', total, contentType: ct, magic: '' }

  const { magic, audio } = magicInfo(resp.raw)
  // 加密封装（酷我 mgg/mflac 等）：content-type 为 octet-stream，但文件头不是任何已知音频魔数，
  // 浏览器解码器无法识别，表现为"能下载但播放失败"。实测这类直链必须判为不可用，
  // 否则会被 actualQuality 当成高码率无损，造成界面虚假标称。
  if (!audio && /^application\/octet-stream$/i.test(ct)) {
    return { ok: false, reason: '未知音频容器（第三方加密封装，无法解码播放）', total, contentType: ct, magic }
  }
  if (!audio && !AUDIO_CT.test(ct)) {
    return { ok: false, reason: '不是音频数据 (' + ct + ' ' + magic + ')', total, contentType: ct, magic }
  }
  if (total < needBytes) {
    return { ok: false, reason: `体积不足(${(total / 1048576).toFixed(2)}MB < ${(needBytes / 1048576).toFixed(2)}MB)，疑似试听片段`, total, contentType: ct, magic }
  }
  const fi = magic === 'fLaC' ? flacInfo(resp.raw) : null
  return { ok: true, total, contentType: ct, magic, flac: fi }
}

module.exports = { probePlayable, magicInfo, flacInfo, RATE }
