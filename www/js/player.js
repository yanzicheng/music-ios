/* ===========================================================
   播放器内核（移动端 / QQ音乐风格）
   -----------------------------------------------------------
   起播速度优化要点：
   1) URL 本地缓存（8 分钟，与服务端 URL_TTL 对齐）—— 二次起播 0 请求
   2) 并发去重 —— 同一首歌重复点击只发一次解析
   3) 列表预热 —— 面板打开即并行解析前 3 首，服务端同时后台预取前 10 首
   4) 邻曲预热 —— 当前曲目起播后立即解析下一首，下一首切换近乎瞬时
   5) 失败快速切换 —— 缓存未命中/解析失败/音频报错时最多重试 1 次，
      仍失败则自动跳下一首，全部失败才停止并提示
   =========================================================== */
(function () {
  'use strict'

  var audio = new Audio()
  audio.preload = 'auto'
  audio.setAttribute('playsinline', 'playsinline')

  var URL_TTL = 8 * 60 * 1000      // 与服务端 getMusicUrl 的 URL_TTL 对齐
  /* v3.19：前端兜底超时跟服务端 DEADLINE(7s) 走。旧值 6s 比服务端 15s 短太多，
     慢歌还在服务端对冲解析时前端就先判"解析超时"并切歌，这就是"歌没坏却被跳过"的根因。 */
  var URL_TIMEOUT = 10000
  /* v3.19：档位降级链。解析失败先同曲降档自救，而不是立刻换歌 */
  var QUALITY_CHAIN = ['flac24bit', 'flac', '320k', '128k']

  var S = {
    queue: [],
    index: -1,
    playing: false,
    loading: false,
    quality: '320k',
    realQuality: '',
    realInfo: null,
    playMode: 'order',      // order 列表循环 / single 单曲循环 / shuffle 随机
    currentTime: 0,
    duration: 0,
    lyric: [],
    tlyric: [],
    lyricIndex: -1,
    error: '',
    booting: false,
  }

  var handlers = {}
  var loadToken = 0
  var urlCache = {}     // key -> { url, realQuality, expire }
  var urlInflight = {}  // key -> Promise
  var failCount = {}    // key -> 连续失败次数
  var skipStreak = 0    // 连续自动跳过次数（防死循环）

  function on(name, fn) {
    (handlers[name] || (handlers[name] = [])).push(fn)
  }

  function once(name, fn) {
    var wrap = function () {
      var list = handlers[name] || []
      var i = list.indexOf(wrap)
      if (i >= 0) list.splice(i, 1)
      try { fn.apply(null, arguments) } catch (e) { console.warn('[player]', name, e) }
    }
    on(name, wrap)
  }

  function emit(name) {
    var list = handlers[name] || []
    var args = Array.prototype.slice.call(arguments, 1)
    for (var i = 0; i < list.length; i++) {
      try { list[i].apply(null, args) } catch (e) { console.warn('[player]', name, e) }
    }
  }

  function songKey(song) {
    if (!song) return ''
    return (song.source || 'tx') + '_' + (song.songmid || song.songId || song.id || song.name || '')
  }

  function clampIndex(i) {
    var n = S.queue.length
    if (!n) return -1
    var v = Number(i) || 0
    return ((v % n) + n) % n
  }

  /* 音效链必须在用户手势里激活：已开启音效时建链并 resume，否则一律原声直通 */
  function ensureFx() {
    if (!window.AudioFX) return
    try {
      AudioFX.attach(audio, false)
      AudioFX.resume()
    } catch (e) { console.warn('[player] fx', e) }
  }

  /* ---------------- 播放地址：缓存 + 并发去重 + 超时 ---------------- */
  function cacheGet(key) {
    var c = urlCache[key]
    if (!c) return null
    if (c.expire < Date.now()) { delete urlCache[key]; return null }
    return c
  }

  function cacheSet(key, url, realQuality, info) {
    if (!url) return
    urlCache[key] = { url: url, realQuality: realQuality || '', info: info || null, expire: Date.now() + URL_TTL }
  }

  function withTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var done = false
      var timer = setTimeout(function () {
        if (done) return
        done = true
        reject(new Error('解析超时，正在切换音源'))
      }, ms)
      p.then(function (v) {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(v)
      }, function (e) {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(e)
      })
    })
  }

  function resolveUrl(song, quality, opts) {
    opts = opts || {}
    var q = quality || S.quality
    var key = songKey(song) + '|' + q

    /* v3.10 本地已下载文件：直接返回本地地址，不再走音源解析 */
    if (song && song.localUrl) {
      return Promise.resolve({
        url: song.localUrl,
        local: true,
        realQuality: '本地',
        realInfo: { local: true, path: song.localPath || '' },
        cached: true,
      })
    }

    if (!opts.bypass) {
      var hit = cacheGet(key)
      if (hit) return Promise.resolve({ url: hit.url, realQuality: hit.realQuality, realInfo: hit.info, cached: true })
      if (urlInflight[key]) return urlInflight[key]
    }

    var p = withTimeout(API.songUrl(song, q), opts.timeout || URL_TIMEOUT).then(function (info) {
      if (!info || !info.url) throw new Error('该歌曲暂无可用音源')
      cacheSet(key, info.url, info.realQuality || info.quality || q, info)
      delete urlInflight[key]
      return info
    }, function (e) {
      delete urlInflight[key]
      throw e
    })

    if (!opts.bypass) urlInflight[key] = p
    return p
  }

  /* 预热：本地解析前 n 首 + 让服务端后台预取（服务端有并发去重与对冲竞速） */
  function warm(list, n) {
    var songs = (list || []).filter(Boolean)
    if (!songs.length) return
    var k = Math.max(1, Math.min(n || 3, songs.length))

    /* 服务端预取：一次请求把前 10 首地址解析好，命中后前端请求直接返回缓存 */
    try { API.songUrlPrefetch(songs.slice(0, 10), S.quality).catch(function () {}) } catch (e) {}

    /* 前端本地缓存：前 k 首并行解析，用户点下去即可立即赋值 audio.src */
    for (var i = 0; i < k; i++) {
      (function (song) {
        var key = songKey(song) + '|' + S.quality
        if (cacheGet(key) || urlInflight[key]) return
        resolveUrl(song, S.quality, { timeout: 9000 }).catch(function () {})
      })(songs[i])
    }
  }

  function warmNext() {
    var n = S.queue.length
    if (n < 2 || S.index < 0) return
    var nextSong = S.queue[clampIndex(S.index + 1)]
    if (!nextSong) return
    var key = songKey(nextSong) + '|' + S.quality
    if (cacheGet(key) || urlInflight[key]) return
    resolveUrl(nextSong, S.quality, { timeout: 9000 }).catch(function () {})
    /* 再往后一首交给服务端预取，降低串行等待 */
    var n2 = S.queue[clampIndex(S.index + 2)]
    if (n2) {
      try { API.songUrlPrefetch([n2], S.quality).catch(function () {}) } catch (e) {}
    }
  }

  /* ---------------- 歌词解析 ---------------- */
  function parseLrc(text) {
    var out = []
    if (!text) return out
    var lines = String(text).split(/\r?\n/)
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      var re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
      var m
      var times = []
      while ((m = re.exec(line))) {
        var min = Number(m[1]) || 0
        var sec = Number(m[2]) || 0
        var frac = m[3] ? Number((m[3] + '00').slice(0, 3)) / 1000 : 0
        times.push(min * 60 + sec + frac)
      }
      if (!times.length) continue
      var content = line.replace(/\[[^\]]*\]/g, '').trim()
      if (!content) continue
      for (var j = 0; j < times.length; j++) out.push({ t: times[j], text: content })
    }
    out.sort(function (a, b) { return a.t - b.t })
    return out
  }

  function mergeTranslation(main, trans) {
    if (!trans || !trans.length) return main
    var map = {}
    for (var i = 0; i < trans.length; i++) map[Math.round(trans[i].t * 10)] = trans[i].text
    for (var k = 0; k < main.length; k++) {
      var tr = map[Math.round(main[k].t * 10)]
      if (tr && tr !== main[k].text) main[k].tr = tr
    }
    return main
  }

  function buildLyric(song, token) {
    S.lyric = []
    S.tlyric = []
    S.lyricIndex = -1
    emit('lyric', -1)
    API.lyric(song).then(function (res) {
      if (token !== loadToken) return
      var main = parseLrc(res && res.lyric)
      var trans = parseLrc(res && res.tlyric)
      S.lyric = mergeTranslation(main, trans)
      S.tlyric = trans
      S.lyricIndex = -1
      emit('lyric', -1)
    }).catch(function () {
      if (token !== loadToken) return
      S.lyric = []
      emit('lyric', -1)
    })
  }

  /* ---------------- 播放控制 ---------------- */
  function cleanup() {
    loadToken++
    try { audio.pause() } catch (e) {}
    try { audio.removeAttribute('src'); audio.load() } catch (e) {}
    S.index = -1
    S.playing = false
    S.loading = false
    S.booting = false
    S.duration = 0
    S.currentTime = 0
    S.lyric = []
    S.lyricIndex = -1
    emit('song')
    emit('state')
    emit('progress')
    emit('lyric', -1)
  }

  function markSongStart(idx) {
    S.index = idx
    S.loading = true
    S.booting = true
    S.error = ''
    S.duration = 0
    S.currentTime = 0
    S.lyric = []
    S.lyricIndex = -1
    S.realQuality = ''
    S.realInfo = null
    emit('song')
    emit('state')
    emit('progress')
    emit('lyric', -1)
  }

  function autoNext(reason) {
    var n = S.queue.length
    if (n < 2) {
      S.loading = false
      S.booting = false
      S.playing = false
      S.error = reason || '播放失败'
      emit('state')
      emit('error', S.error)
      return
    }
    skipStreak++
    if (skipStreak > n) {
      skipStreak = 0
      S.loading = false
      S.booting = false
      S.playing = false
      S.error = '多首歌曲均无法播放，请检查音源'
      emit('state')
      emit('error', S.error)
      return
    }
    emit('error', (reason || '播放失败') + '，已切换下一首')
    setTimeout(function () { playAt(S.index + 1, { attempt: 0 }) }, 120)
  }

  /* v3.19：切歌先把上一首掐掉，再开始解析。
     旧实现只改 audio.src，而 src 要等解析（最长数秒）才赋值，
     这段空窗里上一首一直在唱 —— 就是"刷歌都翻到下一首了，声音还是上一首"。 */
  function silenceCurrent() {
    try { if (!audio.paused) audio.pause() } catch (e) {}
    S.playing = false
    S.currentTime = 0
    S.duration = 0
  }

  /* v3.19：同曲降档（Hi-Res 拿不到就退无损/320K），替代"一次失败就切歌" */
  function downgradeQuality(q) {
    var i = QUALITY_CHAIN.indexOf(q)
    if (i < 0) return '128k'
    return QUALITY_CHAIN[Math.min(QUALITY_CHAIN.length - 1, i + 1)]
  }

  /**
   * 播放队列第 i 首
   * opts.attempt  当前曲目已重试次数（0 起）
   * opts.bypass   强制绕过缓存重新解析
   * opts.q        本次解析使用的音质档位（缺省用全局档位；降档自救时显式传入）
   * opts.timeout  本次解析超时
   */
  function playAt(i, opts) {
    opts = opts || {}
    if (!S.queue.length) return Promise.resolve()
    var idx = clampIndex(i)
    var song = S.queue[idx]
    var token = ++loadToken
    var attempt = opts.attempt || 0
    var key = songKey(song)
    var q = opts.q || S.quality

    markSongStart(idx)
    silenceCurrent()
    buildLyric(song, token)

    /* 命中本地缓存：立即上屏播放，杜绝"点下去先转圈" */
    var hit = cacheGet(key + '|' + q)
    var p = hit
      ? Promise.resolve({ url: hit.url, realQuality: hit.realQuality, realInfo: hit.info, cached: true })
      : resolveUrl(song, q, { bypass: !!opts.bypass, timeout: opts.timeout })

    return p.then(function (info) {
      if (token !== loadToken) return null
      if (!info || !info.url) throw new Error('该歌曲暂无可用音源')
      S.realQuality = info.realQuality || info.quality || q
      S.realInfo = info.realInfo || info || null
      audio.src = info.local ? info.url : API.proxyUrl(info.url)
      audio.load()
      ensureFx()
      emit('quality', S.realQuality, 'real')
      return audio.play()
    }).then(function (r) {
      if (r === null || token !== loadToken) return
      S.loading = false
      S.booting = false
      S.playing = true
      failCount[key] = 0
      skipStreak = 0
      emit('state')
      emit('song')
      API.historyAdd(song).catch(function () {})
      setMediaSession(song)
      warmNext()
    }).catch(function (e) {
      if (token !== loadToken) return
      var name = (e && e.name) || ''
      var msg = (e && e.message) || '播放失败'

      /* 用户手势被拦截（自动播放策略）：保持就绪状态，等用户点播放 */
      if (/NotAllowed|AbortError|interrupted/i.test(name)) {
        S.loading = false
        S.booting = false
        S.error = '已就绪，点击播放按钮开始'
        emit('state')
        return
      }

      failCount[key] = (failCount[key] || 0) + 1

      /* v3.19：失败不再"一次就切歌"，改成同曲自愈两轮：
         第 1 轮 绕过缓存换音源重解析（同档位），第 2 轮 同曲降档重解析。
         两轮都拿不到地址才真正切下一首，避免慢歌被误判成"解析失败"。 */
      if (attempt < 2) {
        var dq = downgradeQuality(q)
        var next = { attempt: attempt + 1, bypass: true, q: attempt === 0 ? q : dq }
        if (attempt > 0) next.timeout = 7000
        playAt(idx, next)
        return
      }
      autoNext(msg)
    })
  }

  function playList(list, startIndex) {
    S.queue = Array.isArray(list) ? list.slice() : []
    emit('queue')
    if (!S.queue.length) { cleanup(); return Promise.resolve() }
    warm(S.queue, 3)
    return playAt(typeof startIndex === 'number' ? startIndex : 0)
  }

  function setQueue(list, startIndex) {
    return playList(list, startIndex)
  }

  function addToQueue(songs, playNow) {
    if (!Array.isArray(songs) || !songs.length) return 0
    var exist = {}
    for (var i = 0; i < S.queue.length; i++) exist[songKey(S.queue[i])] = true
    var added = 0
    for (var j = 0; j < songs.length; j++) {
      var k = songKey(songs[j])
      if (exist[k]) continue
      S.queue.push(songs[j])
      exist[k] = true
      added++
    }
    emit('queue')
    if (playNow || S.index < 0) playAt(S.index < 0 ? 0 : S.index)
    return added
  }

  function toggle() {
    if (!S.queue.length) return
    if (S.index < 0) { playAt(0); return }
    if (!audio.src) { playAt(S.index, { bypass: true }); return }
    if (S.playing) {
      /* 有淡出时长时先淡出再暂停，避免硬切 */
      if (window.AudioFX) AudioFX.fadeOut(function () { try { audio.pause() } catch (e) {} })
      else audio.pause()
      return
    }
    ensureFx()
    audio.play().catch(function (e) {
      var name = (e && e.name) || ''
      if (/NotAllowed/i.test(name)) {
        emit('error', '请再点一次播放')
        return
      }
      /* 播放位置已失效（缓存过期/链接被拒）→ 重新解析一次 */
      playAt(S.index, { attempt: 1, bypass: true })
    })
  }

  function randomIndex() {
    var n = S.queue.length
    if (n < 2) return 0
    var i = S.index
    var t = 0
    while (t < 12) {
      var r = Math.floor(Math.random() * n)
      if (r !== i) return r
      t++
    }
    return (i + 1) % n
  }

  function next() {
    if (!S.queue.length) return
    playAt(S.playMode === 'shuffle' ? randomIndex() : S.index + 1)
  }

  function prev() {
    if (!S.queue.length) return
    if (S.currentTime > 3) { seek(0); return }
    playAt(S.playMode === 'shuffle' ? randomIndex() : S.index - 1)
  }

  var MODES = ['order', 'single', 'shuffle']

  function setPlayMode(mode) {
    if (MODES.indexOf(mode) < 0) mode = 'order'
    S.playMode = mode
    try { localStorage.setItem('pmode', mode) } catch (e) {}
    emit('mode', mode)
    return mode
  }

  function cyclePlayMode() {
    var i = MODES.indexOf(S.playMode)
    return setPlayMode(MODES[(i + 1) % MODES.length])
  }

  function seek(sec) {
    var d = S.duration || audio.duration || 0
    if (!d || !isFinite(d)) return
    var t = Math.max(0, Math.min(d, Number(sec) || 0))
    try { audio.currentTime = t } catch (e) { return }
    S.currentTime = t
    emit('progress')
  }

  function setQuality(q) {
    if (!q) return
    var changed = q !== S.quality
    S.quality = q
    emit('quality', q, 'requested')
    API.setConfig({ quality: q }).catch(function () {})
    if (!changed) return
    if (S.index < 0 || !audio.src) return
    var pos = S.currentTime
    var wasPlaying = S.playing
    playAt(S.index).then(function () {
      if (pos > 0) seek(pos)
      if (!wasPlaying) { try { audio.pause() } catch (e) {} }
    })
  }

  function removeFromQueue(i) {
    if (i < 0 || i >= S.queue.length) return
    var wasCurrent = i === S.index
    S.queue.splice(i, 1)
    emit('queue')
    if (!S.queue.length) { cleanup(); return }
    if (wasCurrent) {
      playAt(Math.min(i, S.queue.length - 1))
    } else if (i < S.index) {
      S.index--
      emit('state')
    }
  }

  /* ---------------- 歌词同步 ---------------- */
  function syncLyricIndex() {
    var list = S.lyric
    if (!list.length) return
    /* 行切换与逐字填充共用同一提前量（来自 app.js 的 LYRIC_SYNC.lead），
       保证「高亮切行」与「填字推进」严格同步，不再各自偏移 */
    var lead = (typeof window !== 'undefined' && typeof window.__LYRIC_LEAD === 'number') ? window.__LYRIC_LEAD : 0.12
    var t = S.currentTime + lead
    var idx = -1
    var lo = 0
    var hi = list.length - 1
    while (lo <= hi) {
      var mid = (lo + hi) >> 1
      if (list[mid].t <= t) { idx = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    if (idx !== S.lyricIndex) {
      S.lyricIndex = idx
      emit('lyric', idx)
    }
  }

  /* ---------------- 系统媒体控制 ---------------- */
  function setMediaSession(song) {
    if (!('mediaSession' in navigator)) return
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: song.name || '未知歌曲',
        artist: song.singer || '',
        album: song.albumName || '',
        artwork: song.img ? [{ src: API.mediaUrl(song.img, 800), sizes: '800x800', type: 'image/jpeg' }] : [],
      })
      navigator.mediaSession.setActionHandler('play', function () { toggle() })
      navigator.mediaSession.setActionHandler('pause', function () { toggle() })
      navigator.mediaSession.setActionHandler('previoustrack', function () { prev() })
      navigator.mediaSession.setActionHandler('nexttrack', function () { next() })
    } catch (e) {}
  }

  /* ---------------- 音频事件 ---------------- */
  audio.addEventListener('loadedmetadata', function () {
    S.duration = isFinite(audio.duration) ? audio.duration : 0
    /* 部分内核换源后会重置 playbackRate，这里按音效配置重新下发 */
    if (window.AudioFX) { try { AudioFX.reapply() } catch (e) {} }
    emit('progress')
  })
  audio.addEventListener('durationchange', function () {
    S.duration = isFinite(audio.duration) ? audio.duration : 0
    emit('progress')
  })
  audio.addEventListener('timeupdate', function () {
    S.currentTime = audio.currentTime || 0
    emit('progress')
    syncLyricIndex()
  })
  audio.addEventListener('play', function () {
    S.playing = true
    S.loading = false
    S.booting = false
    skipStreak = 0
    if (window.AudioFX) { try { AudioFX.fadeIn() } catch (e) {} }
    emit('state')
  })
  audio.addEventListener('pause', function () {
    S.playing = false
    emit('state')
  })
  audio.addEventListener('waiting', function () {
    S.loading = true
    emit('state')
  })
  audio.addEventListener('playing', function () {
    S.loading = false
    S.booting = false
    S.playing = true
    emit('state')
  })
  audio.addEventListener('canplay', function () {
    S.loading = false
    emit('state')
  })
  audio.addEventListener('seeked', function () {
    S.currentTime = audio.currentTime || 0
    emit('progress')
  })
  audio.addEventListener('ended', function () {
    emit('ended')
    if (S.playMode === 'single' && S.index >= 0) {
      seek(0)
      emit('state')
      try { audio.play() } catch (e) {}
      return
    }
    next()
  })
  audio.addEventListener('error', function () {
    if (!audio.src) return
    var song = S.queue[S.index]
    var key = songKey(song)
    failCount[key] = (failCount[key] || 0) + 1
    S.loading = false
    S.playing = false
    emit('state')
    if (failCount[key] < 2 && S.index >= 0) {
      /* 播放地址可能已过期：绕过缓存重新解析一次 */
      if (key) delete urlCache[key + '|' + S.quality]
      playAt(S.index, { attempt: 1, bypass: true })
      return
    }
    autoNext('音频加载失败')
  })

  window.Player = {
    on: on,
    songKey: songKey,
    bind: on,
    once: once,
    get state() { return S },
    get current() { return S.queue[S.index] || null },
    get audio() { return audio },
    setQueue: setQueue,
    playList: playList,
    warm: warm,
    addToQueue: addToQueue,
    playAt: playAt,
    toggle: toggle,
    next: next,
    prev: prev,
    seek: seek,
    setQuality: setQuality,
    setPlayMode: setPlayMode,
    cyclePlayMode: cyclePlayMode,
    get playMode() { return S.playMode },
    removeFromQueue: removeFromQueue,
    clear: cleanup,
    init: function () {
      try {
        var pm = localStorage.getItem('pmode')
        if (pm && MODES.indexOf(pm) >= 0) S.playMode = pm
        emit('mode', S.playMode)
      } catch (e) {}
      return API.config().then(function (res) {
        if (res && res.config && res.config.quality) {
          S.quality = res.config.quality
          emit('quality', S.quality, 'requested')
        }
        /* 音效配置随 config.json 恢复；这里只载入参数，不建 AudioContext，
           避免未开音效时因上下文挂起导致没有声音 */
        if (res && res.config && window.AudioFX) {
          try { AudioFX.load(res.config.audioFx) } catch (e) { console.warn('[player] fx load', e) }
        }
        return res
      }).catch(function () {})
    },
  }
})()
