"use strict"
/**
 * 封面清晰度统一改写
 * 各平台封面 URL 的尺寸规则互不相同，这里集中把「任意尺寸」的封面重写为「目标尺寸」。
 * 目的：/api/proxy 取图前统一升级，老数据里存的 120/300/500 小图也能自动变清晰。
 *
 * 实测结论（2026-11 联网下载字节确认真实像素，非猜测）：
 *  - QQ 专辑 y.gtimg.cn/music/photo_new/T002R{W}x{W}M000{mid}.jpg
 *      仅支持离散档位：150 / 300 / 500 / 800 可用（返回同尺寸），720 与 1000 → 404
 *  - QQ 排行榜 T003R{W}x{W}：500 返回 300x300，600/800 → 404  => 上限 300
 *  - QQ 歌单广场 qpic.y.qq.com/music_cover/{hash}/{size}：300 / 600 / 1000 可用，500/800 → 400 => 取 600
 *  - 网易云 p*.music.126.net/.../x.jpg?param=WxH：去参数即原图（实测 800x800）
 *  - 酷我 img*.kuwo.cn/star/albumcover/{size}/...：120/500/800 均可用（800 返回 800x800）
 *  - 酷狗 imge.kugou.com/stdmusic/{size}/...：400/480/720/800 均 200（800 返回 800x800）
 *
 * 未验证的平台（咪咕等）只在 URL 自带 {size} 占位符或明确尺寸段时才改写，避免把可用地址改坏。
 */

const MIN_PX = 200
const MAX_PX = 1000
const QQ_PHOTO_MAX = 800
const QQ_TOPLIST_MAX = 300
const QQ_PHOTO_SIZES = [150, 300, 500, 800]
const QQ_QPIC_SIZES = [150, 300, 600, 1000]

function clampPx(px, def) {
  const n = Number(px)
  if (!isFinite(n) || n <= 0) return def
  return Math.max(MIN_PX, Math.min(MAX_PX, Math.round(n)))
}

/** 吸附到平台允许的、不小于目标的最小档位；没有更大档位时取最大档 */
function pickSize(sizes, want) {
  const asc = sizes.slice().sort((a, b) => a - b)
  for (const s of asc) if (s >= want) return s
  return asc[asc.length - 1]
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase() } catch (_) { return '' }
}

/**
 * 把封面地址重写为目标尺寸（取平台支持的最大清晰度）
 * @param {string} url 原始封面地址（任意尺寸）
 * @param {number} px  目标边长（CSS 像素 x DPR）
 * @returns {string} 改写后的地址；无法识别/未验证的平台原样返回
 */
function upgradeCoverUrl(url, px) {
  if (!url) return url || ''
  const s = String(url).trim()
  if (!/^https?:\/\//i.test(s)) return s
  const want = clampPx(px, 700)
  const host = hostOf(s)
  if (!host) return s

  /* ---- 1) QQ 专辑 / 歌手 / 排行榜：.../music/photo_new/T00xR{W}x{W}M000{mid}.jpg ---- */
  if (host.indexOf('gtimg.') > -1) {
    const m = s.match(/\/music\/photo_new\/T00(\d)R(\d+)x(\d+)(M000)/i)
    if (m) {
      const kind = m[1]
      const cur = Number(m[2])
      const cap = (kind === '2' || kind === '1') ? QQ_PHOTO_MAX : QQ_TOPLIST_MAX
      let size
      if (kind === '2' || kind === '1') {
        size = Math.min(pickSize(QQ_PHOTO_SIZES, want), cap)   // 离散档位
      } else {
        size = Math.min(Math.max(cur, want), cap)
      }
      if (size === cur) return s
      return s.replace(/(\/music\/photo_new\/T00\dR)\d+x\d+(M000)/i, '$1' + size + 'x' + size + '$2')
    }
    return s
  }

  /* ---- 2) QQ 歌单广场：.../music_cover/{hash}/{size} ---- */
  if (host.indexOf('qpic.') > -1) {
    if (/\/music_cover\//.test(s)) {
      const size = pickSize(QQ_QPIC_SIZES, want)
      const m = s.match(/^(.*\/music_cover\/[^/]+)\/(\d+)(\?.*)?$/i)
      if (m) return Number(m[2]) === size ? s : (m[1] + '/' + size + (m[3] || ''))
      if (/\/music_cover\/[^/]+$/i.test(s)) return s + '/' + size
    }
    return s
  }

  /* ---- 3) 网易云：小图加 param，大图直接去参数拿原图（质量最高） ---- */
  if (host.indexOf('126.net') > -1) {
    const baseUrl = s.split('?')[0]
    if (want <= 300) return baseUrl + '?param=' + want + 'y' + want
    return baseUrl
  }

  /* ---- 4) 酷我：/star/albumcover/{size}/... ---- */
  if (host.indexOf('kuwo.cn') > -1) {
    const want2 = want >= 500 ? 800 : 500
    const m = s.match(/\/star\/albumcover\/(\d+)\//)
    if (m) {
      if (Number(m[1]) >= want2) return s
      return s.replace(/(\/star\/albumcover\/)\d+(\/)/, '$1' + want2 + '$2')
    }
    if (/\/albumcover\/\d+\//.test(s)) return s.replace(/(\/albumcover\/)\d+(\/)/, '$1' + want2 + '$2')
    return s
  }

  /* ---- 5) 酷狗：stdmusic / collection / {size} 目录 ---- */
  if (host.indexOf('kugou.com') > -1) {
    const want2 = want >= 480 ? 800 : 480
    const m = s.match(/\/(stdmusic|collection)\/(\d+)\//)
    if (m) {
      if (Number(m[2]) >= want2) return s
      return s.replace(/\/(stdmusic|collection)\/\d+\//, '/' + m[1] + '/' + want2 + '/')
    }
    if (/\{size\}/.test(s)) return s.replace(/\{size\}/g, String(want2))
    return s
  }

  /* ---- 6) 咪咕等：仅处理明确的占位符 / 尺寸段，避免改坏地址 ---- */
  if (/\{size\}/.test(s)) return s.replace(/\{size\}/g, String(want))
  if (host.indexOf('migu.cn') > -1) {
    if (/[?&](?:param|size|w|width)=\d+/.test(s)) {
      return s.replace(/([?&](?:param|size|w|width)=)\d+(y\d+)?/i, '$1' + want + '$2')
    }
    if (/\/(\d{2,4})\/([^/]+\.(?:jpg|jpeg|png|webp))(\?.*)?$/i.test(s)) {
      return s.replace(/\/(\d{2,4})\/([^/]+\.(?:jpg|jpeg|png|webp))(\?.*)?$/i, '/' + want + '/$2$3')
    }
  }
  return s
}

/** 该 URL 是否图片资源（只改图片，绝不碰音频） */
function isImageUrl(url) {
  const s = String(url || '')
  try {
    const p = new URL(s).pathname.toLowerCase()
    if (/\.(jpg|jpeg|png|webp|gif|bmp|avif)$/.test(p)) return true
    if (/\/(music_cover|photo_new|albumcover|stdmusic)\//.test(p)) return true
    return false
  } catch (_) {
    return false
  }
}

module.exports = { upgradeCoverUrl, isImageUrl, clampPx }
