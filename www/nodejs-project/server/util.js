'use strict'
/** 公共格式化工具（对齐洛雪内部行为） */

const ENTITY_MAP = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&ldquo;': '“', '&rdquo;': '”', '&middot;': '·', '&hellip;': '…',
  '&mdash;': '—', '&ndash;': '–', '&lsquo;': '‘', '&rsquo;': '’',
}

/** 解码 HTML 实体（替代浏览器 DOMParser） */
const decodeName = (str) => {
  if (!str) return ''
  let s = String(str)
  if (s.indexOf('&') === -1) return s
  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  s = s.replace(/&[a-zA-Z]+;/g, m => ENTITY_MAP[m] !== undefined ? ENTITY_MAP[m] : m)
  return s
}

/** 秒 → mm:ss */
const formatPlayTime = (time) => {
  let num = Number(time)
  if (!isFinite(num) || num < 0) num = 0
  num = Math.trunc(num)
  const h = Math.floor(num / 3600)
  const m = Math.floor((num % 3600) / 60)
  const s = num % 60
  const pad = n => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** 字节 → 人类可读 */
const sizeFormate = (size) => {
  let num = Number(size)
  if (!isFinite(num) || num <= 0) return '0B'
  const units = ['B', 'K', 'M', 'G', 'T']
  let i = 0
  while (num >= 1024 && i < units.length - 1) { num /= 1024; i++ }
  return `${i === 0 ? num : Math.round(num * 100) / 100}${units[i]}`
}

/** 播放量 → 1.2万 / 3.4亿 */
const formatPlayCount = (num) => {
  const n = Number(num) || 0
  if (n > 100000000) return `${Math.trunc(n / 10000000) / 10}亿`
  if (n > 10000) return `${Math.trunc(n / 1000) / 10}万`
  return String(n)
}

const pad = n => String(n).padStart(2, '0')

/** 时间戳 → YYYY-MM-DD */
const dateFormat = (time) => {
  const d = new Date(Number(time) || Date.now())
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 时间戳 → YYYY-MM-DD HH:mm:ss */
const dateFormat3 = (time) => {
  const d = new Date(Number(time) || Date.now())
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 相对时间：刚刚 / x分钟前 / x小时前 / 日期 */
const dateFormat2 = (time) => {
  const differ = Math.trunc((Date.now() - Number(time)) / 1000)
  if (!isFinite(differ) || differ < 0) return dateFormat(time)
  if (differ < 60) return `${differ}秒前`
  if (differ < 3600) return `${Math.trunc(differ / 60)}分钟前`
  if (differ < 86400) return `${Math.trunc(differ / 3600)}小时前`
  return dateFormat(time)
}

/** 歌手数组 → 字符串 */
const formatSingerName = (singers, nameKey = 'name', join = '、') => {
  if (Array.isArray(singers)) {
    const names = []
    for (const item of singers) {
      const n = item && item[nameKey]
      if (n) names.push(n)
    }
    return decodeName(names.join(join))
  }
  return decodeName(String(singers ?? ''))
}

module.exports = {
  decodeName,
  formatPlayTime,
  sizeFormate,
  formatPlayCount,
  dateFormat,
  dateFormat2,
  dateFormat3,
  formatSingerName,
}
