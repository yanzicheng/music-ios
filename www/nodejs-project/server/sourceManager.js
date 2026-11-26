'use strict'
/**
 * 音源管理器：加载 D:\学习\音乐\音源 下所有洛雪格式音源脚本，
 * 按优先级为播放请求挑选可用音源，并提供自动降级链。
 */
const fs = require('node:fs')
const path = require('node:path')
const { ApiSource } = require('./apiSource')
const { probePlayable } = require('./probe')

// 音源目录：安卓内嵌运行时由 main.js 通过 LX_SRC_DIR 注入，桌面端保持原逻辑
const SRC_DIR = process.env.LX_SRC_DIR ? path.resolve(process.env.LX_SRC_DIR) : path.resolve(__dirname, '../../音源')

/**
 * 音质档位降级链：
 *  - 具体档位：128k / 320k / flac / flac24bit
 *  - auto     ：最高可用逐级尝试，界面按实测真实标注（不虚假标称）
 *  - lossless ：严格无损（只接受实测确认为真 FLAC 的直链，有损冒充一律换源）
 */
const QUALITY_FALLBACK = {
  '128k': ['128k'],
  '320k': ['320k', '128k'],
  flac: ['flac', '320k', '128k'],
  flac24bit: ['flac24bit', 'flac', '320k', '128k'],
  auto: ['flac24bit', 'flac', '320k', '128k'],
  lossless: ['flac24bit', 'flac'],
}

/** 严格无损档位（实测为有损/非 FLAC 容器的一律丢弃，不降级标称） */
const LOSSLESS_ONLY = new Set(['lossless'])

/** 无损类档位（用于统计"标称无损 / 实为无损"的命中率） */
const LOSSLESS_TIERS = new Set(['flac', 'flac24bit'])

/**
 * 平台通道黑名单（2026-11-19 音质整改实测结论）
 * 命中后该音源在对应平台的通道被直接摘除：不参与候选、不出现在 capabilities 里，
 * 避免"标称 flac24bit 实则 16bit / MP3 320k"的通道挤占取址名额。
 */
const PLATFORM_DENY = {
  // 🌐HelloWorld 的 tx 走自建代理 103.79.184.97：flac24bit 请求超时后降级 320k，
  // 实测晴天/演员仅 16bit，且首次起播被拖慢约 5s —— 只保留其 kw 通道（实测真 24bit）
  '🌐HelloWorld音源 v260925.js': ['tx'],
}

/**
 * 平台优先级：kw 是当前唯一稳定提供真 24bit 的通道（同一酷我 CDN，实测全部 24bit/48kHz），
 * 因此非 kw 请求会先在 kw 找同一首歌（见 index.js preferKwSong），tx 只在 kw 无结果时兜底。
 * 数值越小越优先。
 */
const PLATFORM_RANK = { kw: 0, kg: 1, mg: 2, wy: 3, tx: 4, local: 5 }

/** 从探针结果提取实测编码/位深/采样率，供诊断与前端如实展示 */
function probeSpec(probe) {
  const magic = String((probe && probe.magic) || '')
  const ct = String((probe && probe.contentType) || '')
  const f = probe && probe.flac
  let codec = ''
  if (magic === 'fLaC' || /flac/i.test(ct)) codec = 'flac'
  else if (magic === 'OggS' || /ogg/i.test(ct)) codec = 'ogg'
  else if (magic === 'RIFF' || /wav/i.test(ct)) codec = 'wav'
  else if (/m4a|mp4/i.test(ct) || magic.includes('ftyp')) codec = 'aac'
  else if (magic.startsWith('ID3') || (probe && probe.magic)) codec = 'mp3'
  return {
    codec,
    bitsPerSample: f ? f.bitsPerSample : 0,
    sampleRate: f ? f.sampleRate : 0,
    channels: f ? f.channels : 0,
  }
}

/**
 * 按探测到的真实音频格式校正标称音质
 * 部分第三方音源忽略请求档位，统一返回 FLAC；不校正会导致界面标称与实际不符。
 */
function actualQuality(requested, probe, seconds) {
  const magic = String((probe && probe.magic) || '')
  const ct = String((probe && probe.contentType) || '')
  if (magic === 'fLaC' || /flac/i.test(ct)) {
    const f = probe && probe.flac
    return f && f.bitsPerSample >= 24 ? 'flac24bit' : 'flac'
  }
  if (magic === 'OggS' || /ogg/i.test(ct)) return 'ogg'
  if (magic === 'RIFF' || /wav/i.test(ct)) return 'wav'
  if (/m4a|mp4/i.test(ct) || String(probe && probe.magic).includes('ftyp')) return 'm4a'
  // mp3 类：请求档位为无损但实际拿到有损，按体积与时长估码率
  if (requested === 'flac' || requested === 'flac24bit') {
    const total = (probe && probe.total) || 0
    const kbps = seconds > 0 ? (total * 8) / seconds / 1000 : 0
    // 酷我等源的私有封装（\x03\x1b.p 头）没有 fLaC 魔数，码率极高时按无损处理
    if (kbps >= 900) return 'flac'
    // 音源未上传时长时无法算码率，按体积兜底，避免无损请求被误标成 128k
    if (!(seconds > 0)) return total > 6 * 1048576 ? '320k' : '128k'
    return kbps >= 240 ? '320k' : '128k'
  }
  return requested
}

class SourceManager {
  constructor({ log = () => {} } = {}) {
    this.log = log
    this.instances = [] // ApiSource[]
    this.ready = false
    this.loading = null
    this.urlCache = new Map()
    this.pending = new Map() // 同一首歌的并发解析去重（预取与点击播放共用一次解析）
    this.stats = new Map() // 音源成功率统计 fileName -> {ok, fail}
    // 音质可信度统计 fileName -> { claim, real, fake }：标称无损 vs 实测无损，用于排序时优先真实无损源
    this.qualityStats = new Map()
  }

  /** 播放地址缓存有效期（音频直链通常较长，缓存越久起播越快） */
  static get URL_TTL() { return 8 * 60 * 1000 }
  /** 过期后仍可作为兜底返回的宽限期（网络异常时先播出来，后台再刷新） */
  static get URL_STALE() { return 40 * 60 * 1000 }

  /** 扫描并初始化所有音源（并发，失败不阻断） */
  load() {
    if (this.loading) return this.loading
    this.loading = (async () => {
      if (!fs.existsSync(SRC_DIR)) {
        this.log('音源目录不存在: ' + SRC_DIR)
        this.ready = true
        return this
      }
      const files = fs.readdirSync(SRC_DIR).filter(f => f.toLowerCase().endsWith('.js'))
      const tasks = files.map(async f => {
        const api = new ApiSource(path.join(SRC_DIR, f), { log: () => {} })
        try {
          await api.init(25000)
          // 摘除实测不合格的平台通道（例：HelloWorld 的 tx），后续候选/能力表都不再包含它
          const deny = PLATFORM_DENY[f]
          if (deny) {
            for (const p of deny) {
              if (api.sources[p]) {
                delete api.sources[p]
                this.log(`通道已禁用: ${api.meta.name}/${p}（实测音质或时延不达标）`)
              }
            }
          }
          if (api.sourceList.length) {
            api.priority = this.calcPriority(api)
            this.instances.push(api)
            this.log(`音源就绪: ${api.meta.name} [${api.sourceList.join('/')}]`)
          }
        } catch (e) {
          api.status = 'error'
          this.log(`音源不可用: ${f} -> ${e.message}`)
        }
      })
      await Promise.all(tasks)
      // 优先级：支持平台多的、版本新的优先
      this.instances.sort((a, b) => b.priority - a.priority)
      this.ready = true
      this.log(`音源初始化完成，可用 ${this.instances.length} 个`)
      return this
    })()
    return this.loading
  }

  calcPriority(api) {
    let score = api.sourceList.length * 10
    score += Math.min(Object.values(api.sources).reduce((n, s) => n + s.qualitys.length, 0), 20)
    /**
     * 实测音质加成（2026-11-19 按"只保留最好音质"重排）
     * 排序依据：取址实测的位深/采样率 + 容器类型 + 首播时延，标称无损但实测 16bit 的来源一律降权，
     * 星海 v3.2.19 实测 6/6 全失败已移出顶层，此处不再保留加成项。
     */
    const VERIFIED = {
      '非常刀 v5.js': 70, // kw 真 24bit（48kHz），首播最快 —— 头号 kw 通道
      '安妮独家音源 v5.js': 66, // kw 真 24bit
      'K×H测试_v1.7.16.js': 62, // kw 真 24bit
      '星澜聚合音源 v4.0.2.js': 58, // kw 真 24bit
      '🌐HelloWorld音源 v260925.js': 60, // kw 真 24bit（积分维持）；tx 通道已禁用，不再计分
      '聚合音源 特供版.js': 12, // 仅 wy 可播，无 24bit 能力，压到最低档
      'lx-玉宁熙 V1.2.2.js': 8, // 虚标：tx 标称 flac24bit 实测 16bit，唯一可取的 wy 也不稳 —— 大幅降权
      '墨澜聚合音源 v2.2.0.js': 4, // 虚标 + kw 仅试听片段、tx 404，仅 wy 勉强可用 —— 垫底
    }
    score += VERIFIED[path.basename(api.filePath)] || 0
    // 2026-11-19 新增：6 个旧音源全部实测失效，已移入 音源\_失效_20261119，此处不留加成项。
    //   huibq.js          上游 lxmusicapi.onrender.com 恒返 503（服务不可用）
    //   ikun_latest.js    api.ikunshare.com DNS 不存在
    //   sixyin1.2.1.js    tx 依赖的 lx.itooi.cn 站点已暂停，kw 走 mobi.kuwo.cn 返回失败
    //   zhizun.js         服务器 110.42.36.53:1314 端口拒连
    //   monster.js        仅返回 0.18MB 试听片段（M5000），tx 接口为建站默认页
    //   MusicDownloader.js 服务器 ikun.laoguantx.top:19742 端口拒连
    return score
  }

  /** 每个平台可用的音源列表 */
  getCapabilities() {
    const map = {}
    for (const api of this.instances) {
      for (const src of api.sourceList) {
        map[src] = map[src] || { sources: [], qualitys: [] }
        map[src].sources.push({ id: api.meta.fileName, name: api.meta.name, version: api.meta.version })
        for (const q of api.sources[src].qualitys) if (!map[src].qualitys.includes(q)) map[src].qualitys.push(q)
      }
    }
    return map
  }

  list() {
    return this.instances.map(a => ({
      name: a.meta.name,
      version: a.meta.version,
      author: a.meta.author,
      fileName: a.meta.fileName,
      sources: a.sourceList,
      priority: a.priority,
    }))
  }

  /** 取得指定平台可开放的最高音质 */
  bestQuality(source, wanted = '320k') {
    const order = QUALITY_FALLBACK[wanted] || QUALITY_FALLBACK['320k']
    for (const q of order) {
      for (const api of this.instances) if (api.support(source, 'musicUrl') && (api.sources[source].qualitys || []).includes(q)) return q
    }
    return '128k'
  }

  /**
   * 获取播放地址（多音源对冲竞速版）
   * 说明：第三方音源常返回试听片段/错误页，必须探测校验，不能只信服务器拿到假地址
   *
   * 相比串行版本的关键差异：
   *  1) 极速命中：同一首歌的多个音源并行发起请求，谁先解析出地址谁就立刻开始探测，命中即返回
   *  2) 对冲请求：先发高成功率的 N 个，HEDGE_DELAY 内没有结果再补发剩余音源，兼顾速度与成功率
   *  3) 并发去重：同一 cacheKey 的并发调用（预取 + 点击播放）共用一次解析
   *  4) 两级缓存：TTL 内直出；解析失败时用宽限期内的旧直链兜底先播起来
   * @returns {Promise<{url:string, quality:string, api:string, size:number, contentType:string}>}
   */
  async getMusicUrl(source, musicInfo, quality = '320k', opts = {}) {
    if (!this.ready) await this.load()
    const id = musicInfo.songmid || musicInfo.hash || musicInfo.copyrightId || musicInfo.songId || musicInfo.rid
    const cacheKey = `${source}|${id}|${quality}`

    const cached = this.urlCache.get(cacheKey)
    if (cached && cached.expire > Date.now()) return { ...cached.data, cached: true }

    const inflight = this.pending.get(cacheKey)
    if (inflight) return { ...(await inflight), shared: true }

    const task = this._resolveUrl(source, musicInfo, quality, opts)
    this.pending.set(cacheKey, task)
    try {
      return await task
    } catch (e) {
      // 兜底：宽限期内的旧直链参数仍可用，先让播放器出声，避免用户干等
      if (cached && cached.expire + SourceManager.URL_STALE > Date.now()) {
        this.log(`[url] 解析失败改用临期缓存: ${cacheKey}`)
        return { ...cached.data, cached: true, stale: true }
      }
      throw e
    } finally {
      this.pending.delete(cacheKey)
    }
  }

  /** 真正的对冲解析：并发发起 → 即时探测 → 首个可用地址胜出 */
  _resolveUrl(source, musicInfo, quality, opts = {}) {
    const id = musicInfo.songmid || musicInfo.hash || musicInfo.copyrightId || musicInfo.songId || musicInfo.rid
    const cacheKey = `${source}|${id}|${quality}`
    const qualityOrder = QUALITY_FALLBACK[quality] || QUALITY_FALLBACK['320k']
    const seconds = this._durSeconds(musicInfo.interval)
    const candidates = this.instances
      .filter(a => a.support(source, 'musicUrl'))
      .sort((a, b) => {
        // 音质优先：能提供 flac24bit 的音源排在前面（同一平台内先抢真 24bit 通道）
        const hiA = (a.sources[source].qualitys || []).includes('flac24bit') ? 1 : 0
        const hiB = (b.sources[source].qualitys || []).includes('flac24bit') ? 1 : 0
        if (hiA !== hiB) return hiB - hiA
        // 其次按「历史成功率 + 实测无损命中率」，同分时保持 calcPriority 的高分顺序
        return (this._rate(b) + this._trust(b)) - (this._rate(a) + this._trust(a))
      })

    const FIRST_WAVE = Number(process.env.LX_FIRST_WAVE || 5)
    const HEDGE_DELAY = Number(process.env.LX_HEDGE_DELAY || 350)
    /* v3.19：整体解析时限从 15s 压到 7s。实测拖到 15s 的都是音源接口挂起，
       等到 15s 也几乎都是失败，只会让用户干等并触发前端超时误切歌。 */
    const DEADLINE = Number(process.env.LX_RESOLVE_DEADLINE || 7000)
    /* v3.19：单音源取址超时——挂起的音源（实测有 15s 才失败的）不再占着名额等 DEADLINE */
    const SRC_TIMEOUT = Number(process.env.LX_SRC_TIMEOUT || 4500)
    /* v3.19：首档（Hi-Res/无损）迟迟无果时补发降档波次，用 320K/128K 先把歌放出来 */
    const DEGRADE_AFTER = Number(process.env.LX_DEGRADE_AFTER || 3000)

    return new Promise((resolve, reject) => {
      let done = false
      let launched = 0
      let active = 0
      let cursor = 0
      const errors = []
      let deadlineTimer = null
      let hedgeTimer = null
      let degradeTimer = null
      /* v3.19：记录「音源 × 档位」已发过的组合，降档波次补发时避免同一组合重复请求 */
      const firedKeys = new Set()

      const cleanup = () => {
        done = true
        if (deadlineTimer) clearTimeout(deadlineTimer)
        if (hedgeTimer) clearTimeout(hedgeTimer)
        if (degradeTimer) clearTimeout(degradeTimer)
      }

      const succeed = (data) => {
        if (done) return
        cleanup()
        this.urlCache.set(cacheKey, { data, expire: Date.now() + SourceManager.URL_TTL })
        resolve({ ...data, cached: false })
      }

      const maybeFail = () => {
        if (done) return
        // 所有候选都已发出，且没有在途请求时才判定彻底失败，避免误杀仍在解析的音源
        if (cursor < candidates.length || active > 0) return
        cleanup()
        reject(this._noSourceError(source, errors, LOSSLESS_ONLY.has(quality) ? '严格无损模式下无可用音源' : undefined))
      }

      const launchNext = () => {
        if (done) return
        if (cursor < candidates.length) fire(candidates[cursor++])
        else maybeFail()
      }

      /** 当前音源失败：释放在途计数后继续下一个候选 */
      const retry = () => {
        if (active > 0) active--
        launchNext()
      }

      const fire = (api, orderList) => {
        if (done || !api) return
        const supported = api.sources[source].qualitys || []
        const q = (orderList || qualityOrder).find(x => supported.includes(x))
        if (!q) return
        const fk = `${api.meta.name}|${q}`
        if (firedKeys.has(fk)) return
        firedKeys.add(fk)
        launched++
        active++
        let req
        try {
          req = api.request({ source, action: 'musicUrl', info: { type: q, musicInfo } })
        } catch (e) {
          errors.push(`${api.meta.name}/${q}: ${String(e.message).slice(0, 90)}`)
          retry()
          return
        }
        /* v3.19：单音源取址上限 SRC_TIMEOUT，挂起的接口快速判死，把名额让给下一个候选 */
        const guard = new Promise((_, rej) => {
          setTimeout(() => rej(new Error(`取址超时 ${SRC_TIMEOUT}ms`)), SRC_TIMEOUT)
        })
        Promise.race([Promise.resolve(req), guard]).then(url => {
          if (done) return
          if (!url) {
            errors.push(`${api.meta.name}/${q}: 空地址`)
            this._mark(api, false)
            retry()
            return
          }
          // 拿到地址立刻探测，不等同批其它音源
          return probePlayable(url, { quality: q, interval: seconds }).then(p => {
            if (done) return
            if (!p.ok) {
              this._mark(api, false)
              errors.push(`${api.meta.name}/${q}: ${p.reason || '不可播放'}`)
              retry()
              return
            }
            this._mark(api, true)
            const act = actualQuality(q, p, seconds)
            this._markQuality(api, q, act)
            // 严格无损档：实测不是 FLAC 就不算达标，宁可继续换源也不能虚假标称无损
            if (LOSSLESS_ONLY.has(quality) && !LOSSLESS_TIERS.has(act)) {
              errors.push(`${api.meta.name}/${q}: 实测为 ${act}，非真实无损`)
              retry()
              return
            }
            const f = p.flac
            const spec = probeSpec(p)
            succeed({
              url,
              quality: act,
              requested: q,
              detail: f ? `${f.bitsPerSample}bit/${(f.sampleRate / 1000).toFixed(1)}kHz` : '',
              codec: spec.codec,
              bitsPerSample: spec.bitsPerSample,
              sampleRate: spec.sampleRate,
              channels: spec.channels,
              lossless: LOSSLESS_TIERS.has(act),
              // 标称 Hi-Res 但实测仅 16bit：前端提示"标称24bit实则16bit"，避免虚假宣传
              fakeHiRes: q === 'flac24bit' && act === 'flac',
              api: api.meta.name,
              size: p.total,
              contentType: p.contentType,
            })
          })
        }).catch(e => {
          if (done) return
          errors.push(`${api.meta.name}/${q}: ${String(e.message).slice(0, 90)}`)
          this._mark(api, false)
          retry()
        })
      }

      deadlineTimer = setTimeout(() => {
        if (done) return
        cleanup()
        reject(this._noSourceError(source, errors, '解析超时'))
      }, DEADLINE)

      const first = candidates.slice(0, FIRST_WAVE)
      cursor = first.length
      if (!first.length) {
        cleanup()
        reject(this._noSourceError(source, errors))
        return
      }
      for (const api of first) fire(api)

      // 对冲波次：迟迟没有结果时把剩余音源全部补发，避免单个源超时拖慢整体
      hedgeTimer = setTimeout(() => {
        if (done) return
        while (cursor < candidates.length && !done) fire(candidates[cursor++])
      }, HEDGE_DELAY)

      /* v3.19：降档波次——首档（Hi-Res/无损）迟迟没人胜出时，全部候选改走次档重发一遍。
         实测很多曲目 Hi-Res 只能拿到试听片段，而 320K/128K 是通的；
         旧逻辑只在同一档位里反复换源，必然等到 DEADLINE 才判失败并让前端切歌。 */
      degradeTimer = setTimeout(() => {
        if (done) return
        const lower = qualityOrder.filter(x => x !== qualityOrder[0])
        if (!lower.length) return
        this.log(`[url] ${cacheKey} 首档 ${qualityOrder[0]} 无结果，补发降档波次 ${lower.join('/')}`)
        for (const api of candidates) fire(api, lower)
      }, DEGRADE_AFTER)
    })
  }

  _noSourceError(source, errors = [], reason) {
    const tail = errors.slice(0, 3).join('；') || '全部候选失败'
    const err = new Error(reason
      ? `${reason}：没有可用音源返回完整音频（${tail}）`
      : '没有可用音源返回完整音频（可能全部为试听片段或接口失效）')
    err.detail = errors
    return err
  }

  /** 预取：提前解析一批歌曲的播放地址（限制并发，绝不抛错） */
  async prefetch(source, list = [], quality = '320k', concurrency = 3) {
    const queue = (list || []).filter(Boolean).slice(0, 8)
    const workerCount = Math.max(1, Math.min(concurrency, queue.length))
    const workers = []
    for (let i = 0; i < workerCount; i++) {
      workers.push((async () => {
        while (queue.length) {
          const item = queue.shift()
          const id = item.songmid || item.hash || item.copyrightId || item.songId || item.rid
          if (!id) continue
          const src = item.source || source
          const cacheKey = `${src}|${id}|${quality}`
          const cached = this.urlCache.get(cacheKey)
          if (cached && cached.expire > Date.now()) continue
          if (this.pending.has(cacheKey)) continue
          try { await this.getMusicUrl(src, item, quality) } catch (_) {}
        }
      })())
    }
    await Promise.all(workers)
    return 0
  }

  /** 解析 3:52 / 232 这类时长 */
  _durSeconds(v) {
    if (v === undefined || v === null || v === '') return 0
    const s = String(v)
    if (s.includes(':')) {
      const parts = s.split(':').map(Number)
      return parts.reduce((n, x) => n * 60 + (x || 0), 0)
    }
    return Number(s) || 0
  }

  _rate(api) {
    const st = this.stats.get(api.meta.fileName)
    if (!st) return 0.5
    return (st.ok + 1) / (st.ok + st.fail + 2)
  }

  _mark(api, ok) {
    const key = api.meta.fileName
    const st = this.stats.get(key) || { ok: 0, fail: 0 }
    if (ok) st.ok++
    else st.fail++
    this.stats.set(key, st)
  }

  /** 记录"标称无损 vs 实测无损"，供排序把真无损源排前面 */
  _markQuality(api, claimed, actual) {
    if (!LOSSLESS_TIERS.has(claimed)) return
    const key = api.meta.fileName
    const st = this.qualityStats.get(key) || { claim: 0, real: 0, fake: 0 }
    st.claim++
    if (LOSSLESS_TIERS.has(actual)) st.real++
    else st.fake++
    this.qualityStats.set(key, st)
  }

  /** 音质可信度（0~0.4）：实测无损命中率越高，越优先被选中；统计不足时给中性值 */
  _trust(api) {
    const st = this.qualityStats.get(api.meta.fileName)
    if (!st || st.claim < 2) return 0.2
    const ratio = st.real / st.claim
    return 0.4 * ratio
  }

  /** 音质实测汇总（诊断接口 /api/audio/diag 使用） */
  qualityReport() {
    const out = []
    for (const [fileName, st] of this.qualityStats) {
      out.push({
        fileName,
        claim: st.claim,
        real: st.real,
        fake: st.fake,
        realRatio: st.claim ? Number((st.real / st.claim).toFixed(3)) : 0,
      })
    }
    return out.sort((a, b) => b.claim - a.claim)
  }

  async getPic(source, musicInfo) {
    for (const api of this.instances) {
      if (!api.support(source, 'pic')) continue
      try {
        return await api.request({ source, action: 'pic', info: { musicInfo } })
      } catch (_) {}
    }
    return null
  }

  async getLyric(source, musicInfo) {
    for (const api of this.instances) {
      if (!api.support(source, 'lyric')) continue
      try {
        return await api.request({ source, action: 'lyric', info: { musicInfo } })
      } catch (_) {}
    }
    return null
  }
}

module.exports = { SourceManager, QUALITY_FALLBACK, LOSSLESS_ONLY, LOSSLESS_TIERS, PLATFORM_DENY, PLATFORM_RANK, actualQuality, probeSpec, SRC_DIR }

