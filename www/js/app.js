/* ===========================================================
   应用外壳（移动端 / QQ音乐风格）
   -----------------------------------------------------------
   1) 迷你播放器 #mini 常驻：位于 #app 内、标签栏之上，
      是全局唯一实例，任何页面（含歌单/榜单/搜索面板）都不会被销毁
   2) 面板（歌单/榜单/搜索）打开时给 body 加 .panel-open：
      隐藏底部标签栏、迷你播放器下移到安全区上方，保证「选歌页也有播放器」
   3) 唱片区严格 1:1：只切换 .is-loading 状态叠加覆盖层，不写宽高
   =========================================================== */
(function () {
  'use strict'

  var DEFAULT_COVER = 'img/qq/cover-default-800.webp'   // 兜底封面统一取 800px，DPR2/3 下不放大发虚
  var DEFAULT_COVER_MINI = 'img/qq/cover-mini.png'   // 迷你条小尺寸默认封面
  var DEFAULT_COVER_BIG = 'img/qq/cover-album-800.png'   // 全屏播放页大尺寸默认封面（800px，按 DPR2 渲染 514px 不虚）

  var $ = function (s, root) { return (root || document).querySelector(s) }
  var $$ = function (s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)) }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function fmtCount(n) {
    n = Number(n) || 0
    if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿'
    if (n >= 10000) return (n / 10000).toFixed(1) + '万'
    return String(n)
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0))
    var m = Math.floor(sec / 60)
    var s = sec % 60
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
  }

  function ico(id, cls) {
    return '<svg class="icon ' + (cls || '') + '"><use href="#' + id + '"></use></svg>'
  }

  /* 快捷入口插画图标：多色填充内联 SVG（不引入图片资源与依赖）。
     四个入口图形语义各不相同：日历+音符 / 火焰 / 阶梯柱+星 / 心形。 */
  var QUICK_ART = {
    daily: '<svg class="qart" viewBox="0 0 48 48" aria-hidden="true">' +
        '<defs><linearGradient id="qartDailyA" x1="12" y1="12" x2="38" y2="40" gradientUnits="userSpaceOnUse">' +
        '<stop stop-color="#5ADFA3"/><stop offset="1" stop-color="#12B76A"/></linearGradient></defs>' +
        '<rect x="6" y="8" width="36" height="34" rx="12" fill="#E9FBF3"/>' +
        '<rect x="12" y="13" width="24" height="24" rx="7" fill="url(#qartDailyA)"/>' +
        '<rect x="12" y="13" width="24" height="7.5" rx="3.75" fill="#FFFFFF" opacity=".55"/>' +
        '<circle cx="17.6" cy="16.8" r="1.5" fill="#0B9A5B"/>' +
        '<circle cx="28.4" cy="16.8" r="1.5" fill="#0B9A5B"/>' +
        '<path d="M21.4 30.4v-6.2l6.6-1.6v6" fill="none" stroke="#FFFFFF" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>' +
        '<circle cx="19.6" cy="30.6" r="2.3" fill="#FFFFFF"/>' +
        '<circle cx="26.2" cy="29" r="2.3" fill="#FFCF6B"/>' +
      '</svg>',
    hot: '<svg class="qart" viewBox="0 0 48 48" aria-hidden="true">' +
        '<defs><linearGradient id="qartHotA" x1="24" y1="10" x2="24" y2="35" gradientUnits="userSpaceOnUse">' +
        '<stop stop-color="#FF8A3D"/><stop offset=".55" stop-color="#FF5A5F"/><stop offset="1" stop-color="#FF3B7A"/></linearGradient></defs>' +
        '<circle cx="24" cy="24" r="19" fill="#FFF1E8"/>' +
        '<path d="M24 9.6c1 3.2 3.3 5.2 5.2 7.6 2.3 2.9 3.9 5.7 3.9 9.2 0 5.3-4.1 8.9-9.1 8.9s-9.1-3.6-9.1-8.9c0-2.9 1.2-5.4 2.9-7.7.5 1.9 1.3 3.2 2.4 4-.4-3.4.2-6.6 1.6-9.5.7-1.5 1.6-2.6 2.2-3.6Z" fill="url(#qartHotA)"/>' +
        '<path d="M24 20.8c1.9 1.9 3.4 3.4 3.4 5.7a3.4 3.4 0 1 1-6.8 0c0-1.5.8-2.9 1.9-4.2.3.9.8 1.5 1.4 1.8-.2-1.2-.3-2.1.1-3.3Z" fill="#FFD166"/>' +
      '</svg>',
    rank: '<svg class="qart" viewBox="0 0 48 48" aria-hidden="true">' +
        '<defs><linearGradient id="qartRankA" x1="11" y1="20" x2="37" y2="38" gradientUnits="userSpaceOnUse">' +
        '<stop stop-color="#8FB6FF"/><stop offset="1" stop-color="#5B6BFF"/></linearGradient></defs>' +
        '<circle cx="24" cy="27" r="17" fill="#EDF2FF"/>' +
        '<rect x="11" y="27" width="7.4" height="11.4" rx="3.4" fill="#B9CCFF"/>' +
        '<rect x="20.3" y="21" width="7.4" height="17.4" rx="3.4" fill="url(#qartRankA)"/>' +
        '<rect x="29.6" y="15" width="7.4" height="23.4" rx="3.4" fill="#7C5CFF"/>' +
        '<path d="M33.3 6.4l1.5 3.1 3.4.5-2.5 2.4.6 3.4-3-1.6-3 1.6.6-3.4-2.5-2.4 3.4-.5Z" fill="#FFB020"/>' +
      '</svg>',
    fav: '<svg class="qart" viewBox="0 0 48 48" aria-hidden="true">' +
        '<defs><linearGradient id="qartFavA" x1="12" y1="14" x2="36" y2="36" gradientUnits="userSpaceOnUse">' +
        '<stop stop-color="#FF7A9C"/><stop offset="1" stop-color="#FF2D55"/></linearGradient></defs>' +
        '<circle cx="24" cy="24" r="19" fill="#FFEDF1"/>' +
        '<path d="M24 35.2c-1.2-.7-12.6-7.6-12.6-15.3 0-3.9 3-7 6.8-7 2.6 0 4.7 1.3 5.8 3.3 1.1-2 3.2-3.3 5.8-3.3 3.8 0 6.8 3.1 6.8 7 0 7.7-11.4 14.6-12.6 15.3Z" fill="url(#qartFavA)"/>' +
        '<path d="M15.4 18.6c.3-1.7 1.7-2.9 3.4-3" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" opacity=".8"/>' +
      '</svg>',
    /* 播放队列：青蓝歌单卡 + 播放三角 */
    queue: '<svg class="qart" viewBox="0 0 48 48" aria-hidden="true">' +
        '<defs><linearGradient id="qartQueueA" x1="14" y1="16" x2="34" y2="34" gradientUnits="userSpaceOnUse">' +
        '<stop stop-color="#5FD3F3"/><stop offset="1" stop-color="#1B9AF7"/></linearGradient></defs>' +
        '<circle cx="24" cy="24" r="19" fill="#E8F7FE"/>' +
        '<rect x="13" y="12.6" width="22" height="6.4" rx="3.2" fill="#BFE8FB"/>' +
        '<rect x="13" y="21" width="22" height="6.4" rx="3.2" fill="url(#qartQueueA)"/>' +
        '<rect x="13" y="29.4" width="14" height="6.4" rx="3.2" fill="#BFE8FB"/>' +
        '<circle cx="33.4" cy="31.6" r="4.6" fill="#1B9AF7"/>' +
        '<path d="M32.1 29.2l3.9 2.4-3.9 2.4Z" fill="#FFFFFF"/>' +
      '</svg>'
  }

  const ACTIONS = {
    song: []
  }

  /* ---------------- Toast ---------------- */
  var toastTimer = 0
  function toast(msg) {
    var el = $('#toast')
    if (!el) return
    el.textContent = msg
    el.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { el.classList.remove('show') }, 2000)
  }

  /* ---------------- 底部弹层 / 弹窗 ---------------- */
  function sheetOpen(title, html) {
    $('#sheetTitle').textContent = title
    $('#sheetContent').innerHTML = html
    $('#sheet').classList.add('open')
    $('#sheet').setAttribute('aria-hidden', 'false')
  }
  function sheetClose() {
    $('#sheet').classList.remove('open')
    $('#sheet').setAttribute('aria-hidden', 'true')
  }
  function dialogOpen(opts) {
    var d = $('#dialog')
    $('#dialogTitle').textContent = opts.title || '提示'
    var input = $('#dialogInput')
    input.value = opts.value || ''
    input.placeholder = opts.placeholder || ''
    $('#dialogHint').textContent = opts.hint || ''
    d.classList.add('open')
    d.setAttribute('aria-hidden', 'false')
    d._onOk = opts.onOk || null
    setTimeout(function () { try { input.focus() } catch (e) {} }, 60)
  }
  function dialogClose() {
    var d = $('#dialog')
    d.classList.remove('open')
    d.setAttribute('aria-hidden', 'true')
    d._onOk = null
  }

  /* ---------------- 导航 ---------------- */
  function switchTab(name) {
    $$('.page').forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-page') === name)
    })
    /* 刷歌页自带全套控制，隐藏常驻迷你播放器，避免遮挡底部控制区 */
    document.body.setAttribute('data-tab', name)
    $$('#tabbar .tab').forEach(function (t) {
      var on = t.getAttribute('data-tab') === name
      t.classList.toggle('active', on)
      t.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    if (name === 'mine') renderMine()
    if (name === 'swipe') openSwipe()
    if (name === 'home') {
      syncCatTabs()
      if (!homeLoaded && !autoRetry.timer) loadHome()
    }
    renderMini()
  }

  function panelEl(which) {
    if (which === 'search') return $('#searchPanel')
    if (which === 'import') return $('#importPanel')
    return $('#detailPanel')
  }

  function openPanel(which) {
    var el = panelEl(which)
    if (!el) return
    el.classList.add('open')
    el.setAttribute('aria-hidden', 'false')
    document.body.classList.add('panel-open')
  }

  function closePanel(which) {
    var el = panelEl(which)
    if (!el) return
    el.classList.remove('open')
    el.setAttribute('aria-hidden', 'true')
    if (!$('#detailPanel').classList.contains('open') &&
        !$('#searchPanel').classList.contains('open') &&
        !$('#importPanel').classList.contains('open')) {
      document.body.classList.remove('panel-open')
    }
  }

  function playerOpen() {
    $('#player').classList.add('open')
    $('#player').setAttribute('aria-hidden', 'false')
    /* 进入播放页即刷新底栏状态（音质/音效/播放模式），避免显示上次的旧值 */
    renderPlayMode()
    renderSoundBadges()
    renderPlayerSong()
    renderPlayerState()
  }
  function playerClose() {
    $('#player').classList.remove('open')
    $('#player').setAttribute('aria-hidden', 'true')
  }

  /* ---------------- 歌曲行 ---------------- */
  /* 首页区块（热歌榜等）的歌曲列表登记表：点击时按 data-list 找到真实来源，
     避免依赖 songsOfPanel() 而落到空的 detailSongs 上，导致首页点歌无响应 */
  var blockSongs = {}

  function songRows(songs, opts) {
    opts = opts || {}
    var cur = Player.current
    var curKey = cur ? Player.songKey(cur) : ''
    var listAttr = opts.listKey ? ' data-list="' + esc(opts.listKey) + '"' : ''
    return songs.map(function (s, i) {
      var key = Player.songKey(s)
      var playing = curKey && key === curKey
      var cover = s.img ? API.mediaUrl(s.img, API.coverPx(46, 160)) : DEFAULT_COVER
      var sub = [s.singer, s.albumName].filter(Boolean).join(' · ')
      return '' +
        '<button class="song' + (playing ? ' playing' : '') + '" type="button" data-act="play-index" data-index="' + i + '"' + listAttr + '>' +
          '<span class="s-idx">' + (playing ? ico('i-eq') : (i + 1)) + '</span>' +
          '<span class="s-cover"><img src="' + esc(cover) + '" alt="" loading="lazy" onerror="this.src=\'' + DEFAULT_COVER + '\'"></span>' +
          '<span class="s-main">' +
            '<span class="s-name">' + esc(s.name || '未知歌曲') + '</span>' +
            '<span class="s-sub">' + esc(sub || '未知歌手') + '</span>' +
          '</span>' +
          '<span class="s-fav' + (isFav(s) ? ' on' : '') + '" data-act="toggle-fav" data-index="' + i + '">' +
            (isFav(s) ? ico('i-heart-fill') : ico('i-heart')) +
          '</span>' +
        '</button>'
    }).join('')
  }

  function songListShell(songs, opts) {
    opts = opts || {}
    if (!songs || !songs.length) return '<div class="empty">暂无歌曲</div>'
    return '<div class="song-list' + (opts.flush ? ' flush' : '') + '">' + songRows(songs, opts) + '</div>'
  }

  /* ---------------- 我喜欢 ---------------- */
  var lib = { favorites: [], playlists: [] }

  function isFav(song) {
    if (!song) return false
    var k = Player.songKey(song)
    for (var i = 0; i < lib.favorites.length; i++) {
      if (Player.songKey(lib.favorites[i]) === k) return true
    }
    return false
  }

  function loadLibrary() {
    return API.library().then(function (res) {
      lib.favorites = res.favorites || []
      lib.playlists = res.playlists || []
      return lib
    }).catch(function () { return lib })
  }

  function toggleFav(song) {
    if (!song) return
    var on = isFav(song)
    API.favorite(song, on ? 'remove' : 'add').then(function () {
      return loadLibrary()
    }).then(function () {
      toast(on ? '已取消喜欢' : '已加入我喜欢')
      refreshLists()
      renderMine()
      syncPlayerFav()
      /* v3.6：迷你条小红心与刷歌页喜欢按钮同步选中态 */
      renderMini()
      updateSwipeState()
      /* v3.18：喜欢/取消喜欢后重建口味画像，后续推荐批次立刻跟着变 */
      loadSwipeTaste(true)
    }).catch(function (e) { toast(e.message || '操作失败') })
  }

  /* ===========================================================
     首页（对齐 QQ音乐）
     -----------------------------------------------------------
     结构：顶部仅搜索栏 → 固定分类行（推荐/乐馆/排行榜/歌手/歌单）
           → 分类内容区（分类行在滚动容器之外，绝不随内容滚动）
     数据：统一走 /api/daily（服务端当日缓存，无网降级旧缓存）
     =========================================================== */
  var HOME_CATS = ['recommend', 'hall', 'rank', 'artist', 'playlist']
  var homeCat = 'recommend'
  var homeLoaded = false

  // 每日同步数据（当日缓存优先，无网降级旧缓存）
  var daily = {
    date: '', updatedAt: '', cached: false, degraded: false,
    toplists: [], ranks: [], newSongs: [], hotSongs: [], recommend: [], singers: [],
  }
  var dailyLoaded = false

  /** 数据同步状态提示（当日缓存 / 降级旧缓存 / 日期） */
  function dailyTip() {
    if (!dailyLoaded) return ''
    var d = daily.date || ''
    var txt = d ? '已同步 ' + d : '已同步'
    if (daily.degraded) txt = '当前无网络，展示 ' + d + ' 的缓存'
    else if (daily.cached) txt += ' · 每日自动更新'
    return '<div class="daily-tip">' + ico('i-clock') + '<span>' + esc(txt) + '</span></div>'
  }

  function catSwitch(cat) {
    if (HOME_CATS.indexOf(cat) < 0) return
    homeCat = cat
    syncCatTabs()
    var box = $('#homeScroll')
    if (box) box.scrollTop = 0
    renderHome()
  }

  function syncCatTabs() {
    $$('#catTabs .cat-tab').forEach(function (b) {
      var on = b.getAttribute('data-cat') === homeCat
      b.classList.toggle('active', on)
      b.setAttribute('aria-selected', on ? 'true' : 'false')
    })
  }

  function quickGrid() {
    /* 四项与顶部固定分类行（推荐/乐馆/排行榜/歌手/歌单）不得重名 */
    return '' +
      '<div class="quick-grid">' +
        '<button class="quick" type="button" data-act="open-daily"><span class="quick-ico">' + QUICK_ART.daily + '</span><span class="quick-name">每日推荐</span></button>' +
        '<button class="quick" type="button" data-act="open-hot"><span class="quick-ico">' + QUICK_ART.hot + '</span><span class="quick-name">热歌榜</span></button>' +
        '<button class="quick" type="button" data-act="open-fav"><span class="quick-ico">' + QUICK_ART.fav + '</span><span class="quick-name">我喜欢</span></button>' +
        '<button class="quick" type="button" data-act="open-queue"><span class="quick-ico">' + QUICK_ART.queue + '</span><span class="quick-name">播放队列</span></button>' +
      '</div>'
  }

  function recommendBlock() {
    var all = (daily.recommend || []).slice(0, 10)
    if (!all.length) return ''
    var list = all
    var cards = list.map(function (p) {
      return '' +
        '<button class="hcard" type="button" data-act="open-playlist" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">' +
          '<span class="hcard-cover">' +
            '<img src="' + esc(p.cover ? API.mediaUrl(p.cover, API.coverPx(150, 320)) : DEFAULT_COVER) + '" alt="" loading="lazy" onerror="this.src=\'' + DEFAULT_COVER + '\'">' +
            '<span class="hcard-play">' + ico('i-play') + '</span>' +
          '</span>' +
          '<span class="hcard-name">' + esc(p.name) + '</span>' +
          '<span class="hcard-sub">' + fmtCount(p.listenCount) + ' 播放</span>' +
        '</button>'
    }).join('')
    return '' +
      '<section class="sec">' +
        '<div class="sec-head"><div class="sec-title">推荐歌单<em>为你精选</em></div>' +
          '<button class="sec-more" type="button" data-act="cat-go" data-cat="playlist">更多' + ico('i-down') + '</button></div>' +
        '<div class="hscroll">' + cards + '</div>' +
      '</section>'
  }

  function rankBlock() {
    var toplists = (daily.toplists || []).slice(0, 3)
    var cards = toplists.map(function (t) {
      var lines = (t.songs || []).slice(0, 3).map(function (s, i) {
        return '<div class="rank-line"><i>' + (i + 1) + '</i>' + esc(s.name) + ' - ' + esc(s.singer) + '</div>'
      }).join('')
      return '' +
        '<button class="rank-card" type="button" data-act="open-toplist" data-id="' + t.id + '" data-name="' + esc(t.name) + '">' +
          '<div class="rank-head">' +
            '<img src="' + esc(t.img ? API.mediaUrl(t.img, API.coverPx(40, 140)) : DEFAULT_COVER) + '" alt="" loading="lazy" onerror="this.src=\'' + DEFAULT_COVER + '\'">' +
            '<div class="rank-head-t"><div class="rank-name">' + esc(t.name) + '</div>' +
              '<div class="rank-tip">' + fmtCount(t.listenCount) + ' 人收听</div></div>' +
          '</div>' +
          '<div class="rank-body">' + (lines || '<div class="rank-line muted">加载中…</div>') + '</div>' +
        '</button>'
    }).join('')
    if (!cards) return ''
    return '' +
      '<section class="sec">' +
        '<div class="sec-head"><div class="sec-title">榜单速览</div>' +
          '<button class="sec-more" type="button" data-act="cat-go" data-cat="rank">全部' + ico('i-down') + '</button></div>' +
        '<div class="rank-cards">' + cards + '</div>' +
      '</section>'
  }

  /* 新歌速递：取每日同步的「新歌榜」 */
  function newSongBlock() {
    var songs = (daily.newSongs || []).slice(0, 6)
    if (!songs.length) return ''
    blockSongs.newSongs = songs
    return '' +
      '<section class="sec">' +
        '<div class="sec-head"><div class="sec-title">新歌速递<em>每日同步</em></div>' +
          '<button class="sec-more" type="button" data-act="open-toplist" data-id="' + (newSongsTopId() || '') + '" data-name="新歌榜">播放全部' + ico('i-down') + '</button></div>' +
        songListShell(songs, { listKey: 'newSongs' }) +
      '</section>'
  }

  function newSongsTopId() {
    var id = ''
    ;(daily.ranks || []).forEach(function (r) { if (!id && /新歌/.test(r.name || '')) id = r.id })
    if (!id) (daily.toplists || []).forEach(function (t) { if (!id && /新歌/.test(t.name || '')) id = t.id })
    return id
  }

  function hotBlock() {
    var hot = null
    ;(daily.ranks || []).forEach(function (r) { if (!hot && /热歌/.test(r.name || '')) hot = r })
    var songs = hot ? (hot.songs || []).slice(0, 6) : (daily.hotSongs || []).slice(0, 6)
    if (!songs.length) return ''
    blockSongs.hot = songs
    return '' +
      '<section class="sec">' +
        '<div class="sec-head"><div class="sec-title">' + esc((hot && hot.name) || '热歌榜') + '</div>' +
          '<button class="sec-more" type="button" data-act="open-toplist" data-id="' + ((hot && hot.id) || '') + '" data-name="' + esc((hot && hot.name) || '热歌榜') + '">查看全部' + ico('i-down') + '</button></div>' +
        songListShell(songs, { listKey: 'hot' }) +
      '</section>'
  }

  /* 乐馆：分类导航（无编辑精选、无排行榜重复区块）+ 推荐歌单
     注意：入口名不得与顶部固定分类行（推荐/乐馆/排行榜/歌手/歌单）同屏重名，故加「全部」前缀 */
  var HALL_ENTRIES = [
    { name: '全部排行榜', act: 'cat-go', cat: 'rank', icon: 'i-list', tone: 'violet' },
    { name: '全部歌手', act: 'cat-go', cat: 'artist', icon: 'i-compass', tone: 'blue' },
    { name: '全部歌单', act: 'cat-go', cat: 'playlist', icon: 'i-note', tone: 'green' },
    { name: '每日推荐', act: 'open-daily', icon: 'i-star', tone: 'amber' },
    { name: '我喜欢', act: 'open-fav', icon: 'i-heart', tone: 'pink' },
    { name: '播放队列', act: 'open-queue', icon: 'i-queue', tone: 'cyan' },
  ]

  function hallBlock() {
    var entries = HALL_ENTRIES.map(function (c) {
      return '<button class="hall-item" type="button" data-act="' + c.act + '"' + (c.cat ? ' data-cat="' + c.cat + '"' : '') + '>' +
        '<span class="hall-chip ' + (c.tone ? 'tone-' + c.tone : '') + '">' + ico(c.icon) + '</span>' +
        '<span class="hall-name">' + c.name + '</span></button>'
    }).join('')
    var picks = (daily.recommend || []).slice(0, 6).map(function (p) {
      return '' +
        '<button class="gcard" type="button" data-act="open-playlist" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">' +
          '<span class="gcard-cover">' +
            '<img src="' + esc(p.cover ? API.mediaUrl(p.cover, API.coverPx(170, 360)) : DEFAULT_COVER) + '" alt="" loading="lazy" onerror="this.src=\'' + DEFAULT_COVER + '\'">' +
            '<span class="gcard-badge"><span>' + esc(p.creator || '') + '</span><span>' + ico('i-play') + '</span></span>' +
          '</span>' +
          '<div class="gcard-name">' + esc(p.name) + '</div>' +
        '</button>'
    }).join('')
    return '' +
      '<section class="sec sec-first"><div class="sec-head"><div class="sec-title">分类</div></div>' +
        '<div class="hall-grid">' + entries + '</div></section>' +
      '<section class="sec"><div class="sec-head"><div class="sec-title">推荐歌单</div>' +
        '<button class="sec-more" type="button" data-act="cat-go" data-cat="playlist">更多' + ico('i-down') + '</button></div>' +
        '<div class="grid2">' + (picks || '<div class="empty">暂无歌单</div>') + '</div></section>'
  }

  /* 排行榜分类：榜单明细卡（前 3 首）+ 全部榜单入口 */
  function rankCatBlock() {
    var ranks = daily.ranks || []
    var cards = ranks.map(function (r) {
      var lines = (r.songs || []).slice(0, 3).map(function (s, i) {
        return '<div class="rank-line"><i>' + (i + 1) + '</i>' + esc(s.name) + ' - ' + esc(s.singer) + '</div>'
      }).join('')
      return '<button class="rank-card wide" type="button" data-act="open-toplist" data-id="' + r.id + '" data-name="' + esc(r.name) + '">' +
        '<div class="rank-head">' +
          '<img src="' + esc(r.img ? API.mediaUrl(r.img, API.coverPx(44, 150)) : DEFAULT_COVER) + '" alt="" loading="lazy" onerror="this.src=\'' + DEFAULT_COVER + '\'">' +
          '<div class="rank-head-t"><div class="rank-name">' + esc(r.name) + '</div>' +
            '<div class="rank-tip">' + ((r.songs || []).length ? (r.songs || []).length + ' 首 · 每日更新' : '加载中…') + '</div></div>' +
        '</div>' +
        '<div class="rank-body">' + (lines || '<div class="rank-line muted">加载中…</div>') + '</div>' +
      '</button>'
    }).join('')
    var rest = (daily.toplists || []).slice(3).map(function (t) {
      return '<button class="pl-row" type="button" data-act="open-toplist" data-id="' + t.id + '" data-name="' + esc(t.name) + '">' +
        '<span class="pl-cover"><img src="' + esc(t.img ? API.mediaUrl(t.img, API.coverPx(46, 160)) : DEFAULT_COVER) + '" alt="" loading="lazy" onerror="this.src=\'' + DEFAULT_COVER + '\'"></span>' +
        '<span class="pl-main"><span class="pl-name">' + esc(t.name) + '</span>' +
          '<span class="pl-sub">' + fmtCount(t.listenCount) + ' 人收听</span></span>' + ico('i-down', 'cell-arrow') + '</button>'
    }).join('')
    return '' +
      '<section class="sec sec-first"><div class="sec-head"><div class="sec-title">全部榜单<em>每日同步</em></div>' +
        '<button class="sec-more" type="button" data-act="daily-refresh">刷新' + ico('i-refresh') + '</button></div>' +
        '<div class="rank-cards wide">' + (cards || '<div class="empty">暂无榜单</div>') + '</div></section>' +
      (rest ? '<section class="sec"><div class="sec-head"><div class="sec-title">更多榜单</div></div>' +
        '<div class="song-list">' + rest + '</div></section>' : '')
  }

  /* 歌手分类：语种筛选 + 首字母分组（进歌手详情列表） */
  var ARTIST_LANGS = ['全部', '华语', '欧美', '日韩']
  var artistLang = '全部'
  var artistData = { singers: [] }

  function artistInitial(name) {
    var c = String(name || '').charAt(0).toUpperCase()
    return /[A-Z]/.test(c) ? c : '#'
  }

  function artistFiltered() {
    var list = artistData.singers || []
    if (artistLang === '全部') return list
    /* 语种按中文/英文/日韩字符特征近似判定，保证离线可用 */
    return list.filter(function (s) {
      var n = s.name || ''
      var cn = /[\u4e00-\u9fa5]/.test(n)
      var jp = /[\u3040-\u30ff]/.test(n)
      if (artistLang === '华语') return cn
      if (artistLang === '日韩') return jp
      if (artistLang === '欧美') return !cn && !jp
      return true
    })
  }

  function artistBlock() {
    var list = artistFiltered()
    var chips = ARTIST_LANGS.map(function (L) {
      return '<button class="chip' + (L === artistLang ? ' active' : '') + '" type="button" data-act="artist-lang" data-lang="' + L + '">' + L + '</button>'
    }).join('')
    /* 首字母索引 */
    var groups = {}
    list.forEach(function (s) {
      var k = artistInitial(s.name)
      ;(groups[k] = groups[k] || []).push(s)
    })
    var keys = Object.keys(groups).sort(function (a, b) {
      if (a === '#') return 1
      if (b === '#') return -1
      return a < b ? -1 : 1
    })
    var index = keys.map(function (k) { return '<button class="idx" type="button" data-act="artist-jump" data-key="' + k + '">' + k + '</button>' }).join('')
    var body = keys.map(function (k) {
      var items = groups[k].map(function (s) {
        var img = s.song && s.song.img ? API.mediaUrl(s.song.img, API.coverPx(56, 160)) : ''
        return '<button class="artist-item" type="button" data-act="artist-open" data-name="' + esc(s.name) + '">' +
          '<span class="artist-av">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : ico('i-user')) + '</span>' +
          '<span class="artist-name">' + esc(s.name) + '</span></button>'
      }).join('')
      return '<div class="artist-group" id="ag-' + k + '"><div class="ag-key">' + k + '</div><div class="artist-list">' + items + '</div></div>'
    }).join('')
    return '' +
      '<div class="chips-row">' + chips + '</div>' +
      '<div class="idx-row">' + index + '</div>' +
      (body || '<div class="empty">暂未同步到歌手数据</div>')
  }

  /* 歌单分类：推荐歌单全量网格 */
  function playlistCatBlock() {
    var picks = (daily.recommend || []).map(function (p) {
      return '<button class="gcard" type="button" data-act="open-playlist" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">' +
        '<span class="gcard-cover">' +
          '<img src="' + esc(p.cover ? API.mediaUrl(p.cover, API.coverPx(170, 360)) : DEFAULT_COVER) + '" alt="" loading="lazy" onerror="this.src=\'' + DEFAULT_COVER + '\'">' +
          '<span class="gcard-badge"><span>' + esc(p.creator || '') + '</span><span>' + ico('i-play') + '</span></span>' +
        '</span>' +
        '<div class="gcard-name">' + esc(p.name) + '</div></button>'
    }).join('')
    return '<section class="sec sec-first"><div class="sec-head"><div class="sec-title">推荐歌单<em>每日同步</em></div></div>' +
      '<div class="grid2">' + (picks || '<div class="empty">暂无歌单</div>') + '</div></section>'
  }

  /** 首次进入时的加载文案：探测阶段提示"连接本地服务"，避免误以为已失败 */
  function homeLoadingText() {
    var st = (API.status ? API.status() : null) || {}
    if (st.phase === 'probing') {
      return '正在连接本地服务…（第 ' + (st.round || 1) + ' 次探测 / 已 ' + Math.round((st.elapsed || 0) / 1000) + ' 秒）'
    }
    if (st.phase === 'idle' || st.phase === 'fail') return '正在连接本地服务…'
    return '正在加载推荐…'
  }

  function renderHome() {
    var box = $('#homeScroll')
    if (!box) return
    if (!homeLoaded) {
      box.innerHTML = '<div class="loading"><span class="spin"></span><span>' + esc(homeLoadingText()) + '</span></div>'
      return
    }
    var html = ''
    if (homeCat === 'recommend') html = dailyTip() + quickGrid() + newSongBlock() + rankBlock() + hotBlock() + recommendBlock()
    else if (homeCat === 'hall') html = dailyTip() + hallBlock()
    else if (homeCat === 'rank') html = dailyTip() + rankCatBlock()
    else if (homeCat === 'artist') html = artistBlock()
    else if (homeCat === 'playlist') html = dailyTip() + playlistCatBlock()
    box.innerHTML = html || '<div class="empty">暂无内容</div>'
    syncCatTabs()
  }

  /** 每日数据加载：当日缓存优先，失败自动降级旧缓存 */
  function loadDaily(force) {
    return API.daily(force).then(function (res) {
      daily.date = res.date || ''
      daily.updatedAt = res.updatedAt || ''
      daily.cached = !!res.cached
      daily.degraded = !!res.degraded
      daily.toplists = res.toplists || []
      daily.ranks = res.ranks || []
      daily.newSongs = res.newSongs || []
      daily.hotSongs = res.hotSongs || []
      daily.recommend = res.recommend || []
      daily.singers = res.singers || []
      dailyLoaded = true
      artistData.singers = daily.singers
      return res
    })
  }

  function loadHome() {
    homeLoaded = false
    renderHome()
    return loadDaily().catch(function () {
      /* 兜底：老接口（服务端未升级时仍可出内容） */
      return Promise.all([
        API.recommend().catch(function () { return { list: [] } }),
        API.toplists().catch(function () { return { list: [] } }),
      ]).then(function (res2) {
        daily.recommend = res2[0].list || []
        daily.toplists = res2[1].list || []
        dailyLoaded = true
        artistData.singers = []
      })
    }).then(function () {
      homeLoaded = true
      if (homeCat === 'artist') artistData.singers = daily.singers || []
      renderHome()
      if (!(daily.recommend.length || daily.toplists.length || daily.newSongs.length || daily.hotSongs.length)) {
        box_err_home()
      } else {
        autoRetry.count = 0
        stopAutoRetry()
        loadSwipeFeed()
      }
    })
  }

  /* 错误页自动重试控制：默认每 4 秒重连一次，最多 6 次（约 24 秒） */
  var autoRetry = { timer: 0, count: 0, max: 6, delay: 4000 }

  function stopAutoRetry() {
    if (autoRetry.timer) clearTimeout(autoRetry.timer)
    autoRetry.timer = 0
  }

  function paintAutoRetry(text) {
    var el = $('#homeScroll .err-auto')
    if (el) el.textContent = text || ''
  }

  function scheduleAutoRetry() {
    stopAutoRetry()
    if (autoRetry.count >= autoRetry.max) {
      paintAutoRetry('自动重试已达 ' + autoRetry.max + ' 次仍未成功，请确认服务已启动后点「重试」')
      return
    }
    paintAutoRetry('将在 ' + Math.round(autoRetry.delay / 1000) + ' 秒后自动重试（第 ' +
      (autoRetry.count + 1) + '/' + autoRetry.max + ' 次）')
    autoRetry.timer = setTimeout(function () {
      autoRetry.timer = 0
      /* 错误页已被替换或用户切走，放弃本次自动重试 */
      if (!$('#homeScroll .err-auto')) return
      autoRetry.count++
      paintAutoRetry('正在重连本地服务…（第 ' + autoRetry.count + '/' + autoRetry.max + ' 次）')
      API.reprobe(6000).then(function (b) {
        if (b) loadHome()
        else scheduleAutoRetry()
      }).catch(function () { scheduleAutoRetry() })
    }, autoRetry.delay)
  }

  function box_err_home() {
    $('#homeScroll').innerHTML =
      '<div class="errstate">' + ico('i-alert') +
        '<div class="err-title">加载失败</div>' +
        '<div class="err-sub"></div>' +
        '<div class="err-sub err-auto"></div>' +
        '<button class="err-retry" type="button" data-act="home-retry">重试</button>' +
      '</div>'
    var sub = $('#homeScroll .err-sub')
    if (sub) sub.textContent = API.diagText()
    scheduleAutoRetry()
  }

  /* ---------------- 刷歌（全屏单曲 · 上下滑动切歌） ---------------- */
  var swipeState = { list: [], idx: 0, loaded: false, loading: null, filling: null, shuffling: false }
  /* 调试出口：自动化验证刷歌流用，不影响界面 */
  window.__swipe = {
    state: swipeState,
    pool: function () { return swipePool },
    taste: function () { return swipeTaste },
    seenCount: function () { return swipeSeen.order.length },
    more: function (n) { return swipeFeedMore(n || SWIPE_BATCH) },
  }

  /* ===========================================================
     刷歌：口味加权 + 无限不重复（v3.18）
     -----------------------------------------------------------
     1) 口味画像：喜欢(6) > 收藏歌单(4) > 最近播放(1~3，越新越重)，按歌手聚合；
        已喜欢/已听过的歌本身不再进推荐流，只把"同歌手偏好"作为加权依据；
     2) 候选池：每日新歌/热歌/榜单打底(1~1.2)，再按口味歌手、榜单深挖、
        泛化热词逐页扩展，池子取空自动补；
     3) 加权随机：key = random^(1/w) 取最大，权重越高越靠前，保留随机性；
     4) 无限流：刷到流尾部自动追加下一批；全部数据源见底才提示结束。
        已刷记录持久化（上限 4000 首），跨天翻页也不会重复推同一首。
     =========================================================== */
  var SWIPE_SEEN_KEY = 'chengying.swipe.seen.v319'
  var SWIPE_SEEN_MAX = 4000
  var SWIPE_BATCH = 24
  var SWIPE_PREFETCH = 8
  var SWIPE_SPLIT = /[\/,、&，·;；]+/
  var SWIPE_EXTRA_KW = ['热门', '流行', '华语', '经典老歌', '民谣', '摇滚', '电子',
    '说唱', '古风', '粤语', '英文', '纯音乐', '轻音乐', '情歌', '女声', '男声']

  /* ---------------- 已刷记录（localStorage 持久化） ---------------- */
  var swipeSeen = { map: {}, order: [], dirty: false }

  function swipeSeenLoad() {
    try {
      var arr = JSON.parse(localStorage.getItem(SWIPE_SEEN_KEY) || '[]')
      if (arr && arr.length) {
        swipeSeen.order = arr.slice(-SWIPE_SEEN_MAX)
        for (var i = 0; i < swipeSeen.order.length; i++) swipeSeen.map[swipeSeen.order[i]] = 1
      }
    } catch (e) {}
  }

  function swipeSeenFlush() {
    if (!swipeSeen.dirty) return
    swipeSeen.dirty = false
    try {
      if (swipeSeen.order.length > SWIPE_SEEN_MAX) {
        var drop = swipeSeen.order.splice(0, swipeSeen.order.length - SWIPE_SEEN_MAX)
        for (var i = 0; i < drop.length; i++) delete swipeSeen.map[drop[i]]
      }
      localStorage.setItem(SWIPE_SEEN_KEY, JSON.stringify(swipeSeen.order))
    } catch (e) {}
  }

  /** 池内去重键（带曲目 ID，避免不同来源同一首歌挤占候选池） */
  function swipeKeyOf(s) {
    if (!s) return ''
    return (s.songmid || s.songId || '') + '|' + (s.name || '') + '|' + (s.singer || '')
  }

  /** 已刷判重键：只认"歌名+歌手"，不同来源/不同版本的同一首歌只推一次。
      歌名去全部空白、歌手拆分排序归一，避免"李荣浩"与"李荣浩 "、
      "A、B"与"B、A"这类来源差异被当成两首歌 */
  function swipeSeenKey(s) {
    if (!s || !s.name) return ''
    /* 判重只认歌名：同一首歌常以独唱/合唱/不同来源多份出现，
       带上歌手会让"后会友期-许飞"和"后会友期-群星合唱"被当成两首连着推 */
    return String(s.name).replace(/\s+/g, '').toLowerCase()
  }

  function swipeIsSeen(s) {
    var k = swipeSeenKey(s)
    return !!(k && swipeSeen.map[k])
  }

  function swipeMarkSeen(s) {
    var k = swipeSeenKey(s)
    if (!k || swipeSeen.map[k]) return
    swipeSeen.map[k] = 1
    swipeSeen.order.push(k)
    swipeSeen.dirty = true
  }

  swipeSeenLoad()

  /* ---------------- 口味画像 ---------------- */
  var swipeTaste = { ready: false, loading: null, artists: [], artistW: {}, maxW: 0 }

  function swipeTasteAdd(map, singer, w) {
    var parts = String(singer || '').split(SWIPE_SPLIT)
    for (var i = 0; i < parts.length; i++) {
      var k = parts[i].trim()
      if (!k || k === '未知歌手' || k === '群星') continue
      map[k] = (map[k] || 0) + w
    }
  }

  /** 口味画像：喜欢 > 收藏歌单 > 最近播放（新近度加权） */
  function loadSwipeTaste(force) {
    if (swipeTaste.ready && !force) return Promise.resolve(swipeTaste)
    /* force 时必须丢弃旧 promise，否则喜欢后再也重建不了口味画像 */
    if (swipeTaste.loading) {
      if (!force) return swipeTaste.loading
      swipeTaste.loading = null
    }
    swipeTaste.loading = Promise.all([
      loadLibrary().catch(function () { return lib }),
      API.history().then(function (r) { return (r && r.list) || [] }).catch(function () { return [] }),
    ]).then(function (arr) {
      var favorites = (arr[0] && arr[0].favorites) || []
      var playlists = (arr[0] && arr[0].playlists) || []
      var hist = arr[1] || []
      var w = {}
      /* 收藏/歌单/历史只用于口味加权，不写已刷记录：
         否则用户收藏的几百首被永久排除，刷歌反而推不到自己爱听的歌 */
      favorites.forEach(function (s) { swipeTasteAdd(w, s && s.singer, 6) })
      playlists.forEach(function (pl) {
        (pl.songs || []).forEach(function (s) { swipeTasteAdd(w, s && s.singer, 4) })
      })
      var n = hist.length
      hist.forEach(function (s, i) {
        var wt = 1 + 2 * (1 - i / Math.max(1, n))
        swipeTasteAdd(w, s && s.singer, wt)
        /* 播放历史只做口味加权，不写已刷记录：听过的歌仍可被推荐，
           否则几百条历史会把候选池掏空，导致刷歌越用越少 */
      })
      var list = Object.keys(w).map(function (k) { return { name: k, w: w[k] } })
      list.sort(function (a, b) { return b.w - a.w })
      swipeTaste.artistW = w
      swipeTaste.artists = list
      swipeTaste.maxW = list.length ? list[0].w : 0
      swipeTaste.ready = true
      swipeSeenFlush()
      return swipeTaste
    }).catch(function () {
      swipeTaste.ready = true
      swipeTaste.loading = null
      return swipeTaste
    })
    return swipeTaste.loading
  }

  /** 单曲权重：底权重 + 口味歌手加成（最多 ×4） */
  function swipeWeightOf(s, base) {
    var w = base || 1
    if (!swipeTaste.maxW) return w
    var parts = String((s && s.singer) || '').split(SWIPE_SPLIT)
    var best = 0
    for (var i = 0; i < parts.length; i++) {
      var v = swipeTaste.artistW[parts[i].trim()] || 0
      if (v > best) best = v
    }
    if (best > 0) w += 3 * (best / swipeTaste.maxW)
    return w
  }

  /* ---------------- 候选池 + 扩展任务 ---------------- */
  var swipePool = {
    all: [], map: {}, cursor: 0,
    tasks: [], empty: false,
  }

  function swipePoolPush(s, base) {
    if (!s || !s.name) return false
    /* 没有曲目标识的条目取不到音源，放进刷歌流会切歌即失败并连锁跳歌 */
    if (!s.songmid && !s.songId) return false
    var k = swipeKeyOf(s)
    if (!k || swipePool.map[k]) return false
    swipePool.map[k] = 1
    s.__wbase = base || 1
    s.__w = swipeWeightOf(s, s.__wbase)
    swipePool.all.push(s)
    return true
  }

  /** 对 from 之后（未消费段）按权重重新随机排序：越靠前越可能被优先抽到 */
  function swipeRankFrom(from) {
    var seg = swipePool.all.splice(from)
    for (var i = 0; i < seg.length; i++) {
      var w = Math.max(0.01, seg[i].__w || 1)
      seg[i].__k = Math.pow(Math.random(), 1 / w)
    }
    seg.sort(function (a, b) { return (b.__k || 0) - (a.__k || 0) })
    swipePool.all = swipePool.all.concat(seg)
  }

  function swipePoolBuild() {
    swipePool.all = []
    swipePool.map = {}
    swipePool.cursor = 0
    swipePool.empty = false
    ;(daily.newSongs || []).forEach(function (s) { swipePoolPush(s, 1) })
    ;(daily.hotSongs || []).forEach(function (s) { swipePoolPush(s, 1.1) })
    ;(daily.ranks || []).forEach(function (r) {
      (r.songs || []).forEach(function (s) { swipePoolPush(s, 1.2) })
    })
    ;(daily.toplists || []).forEach(function (t) {
      (t.songs || []).forEach(function (s) { swipePoolPush(s, 1.2) })
    })
    swipeRankFrom(0)
  }

  function swipeTasksBuild(from) {
    var t = []
    from = from || 1
    /* 口味歌手深挖：前 8 位，各 3 页 */
    swipeTaste.artists.slice(0, 8).forEach(function (a) {
      t.push({ kind: 'search', kw: a.name, page: from, pages: from + 2 })
    })
    /* 榜单深挖 */
    ;(daily.toplists || []).slice(0, 6).forEach(function (tl) {
      if (tl && tl.id) t.push({ kind: 'toplist', id: tl.id, page: from, pages: from + 2 })
    })
    /* 泛化热词兜底（顺序随机，保证每次口味不同） */
    var kw = SWIPE_EXTRA_KW.slice()
    for (var i = kw.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1))
      var tmp = kw[i]; kw[i] = kw[j]; kw[j] = tmp
    }
    kw.forEach(function (k) { t.push({ kind: 'search', kw: k, page: from, pages: from + 1 }) })
    swipePool.tasks = t
  }

  function swipeRunTask() {
    var t = swipePool.tasks.shift()
    if (!t) return Promise.resolve(0)
    if (t.page > t.pages) return Promise.resolve(0)
    var page = t.page++
    if (t.page <= t.pages) swipePool.tasks.push(t)
    var req
    if (t.kind === 'search') req = API.search(t.kw, page, 30)
    else if (t.kind === 'toplist') req = API.toplist(t.id, page, 60)
    else req = Promise.resolve({})
    return req.then(function (res) {
      var arr = (res && (res.list || res.songs)) || []
      var added = 0
      for (var i = 0; i < arr.length; i++) if (swipePoolPush(arr[i], 1)) added++
      if (added) swipeRankFrom(swipePool.cursor)
      return added
    }).catch(function () { return 0 })
  }

  /** 从池中取 n 首没刷过的歌（标记为已进流，防止同批重复） */
  function swipeTake(n) {
    var out = []
    /* 流里已有的 + 本批已取的都按"歌名+歌手"占位，
       同一首歌的不同来源版本不会被连着推两次 */
    var used = {}
    for (var i = 0; i < swipeState.list.length; i++) {
      var lk = swipeSeenKey(swipeState.list[i])
      if (lk) used[lk] = 1
    }
    while (out.length < n && swipePool.cursor < swipePool.all.length) {
      var s = swipePool.all[swipePool.cursor++]
      if (!s || swipeIsSeen(s)) continue
      var k = swipeSeenKey(s)
      if (k && used[k]) continue
      if (k) used[k] = 1
      out.push(s)
    }
    return out
  }

  /** 刷歌流追加：池里有就直接取，没有就拉一批新数据再取 */
  function swipeFeedMore(n) {
    if (swipeState.filling) return swipeState.filling
    n = n || SWIPE_BATCH
    var take = swipeTake(n)
    if (take.length) return Promise.resolve(swipeAppend(take))
    if (!swipePool.tasks.length) {
      /* 任务跑完不等于没歌了：换更深的分页再挖几轮，挖不出新歌才提示结束 */
      swipePool.round = (swipePool.round || 0) + 1
      if (swipePool.round <= 3) {
        swipeTasksBuild(swipePool.round * 2)
      } else {
        swipePool.empty = true
        return Promise.resolve(0)
      }
    }
    swipeState.filling = new Promise(function (resolve) {
      var added = 0
      var rounds = 0
      function step() {
        if (added >= n || rounds >= 5 || !swipePool.tasks.length) return resolve(added)
        rounds++
        swipeRunTask().then(function (a) {
          if (a > 0) {
            var t2 = swipeTake(n - added)
            if (t2.length) added += swipeAppend(t2)
          }
          step()
        }).catch(function () { resolve(added) })
      }
      step()
    }).then(function (added) {
      swipeState.filling = null
      if (!added && !swipePool.tasks.length) swipePool.empty = true
      return added
    })
    return swipeState.filling
  }

  function swipeAppend(list) {
    if (!list || !list.length) return 0
    var baseLen = swipeState.list.length
    for (var i = 0; i < list.length; i++) swipeState.list.push(list[i])
    /* 播放器队列跟着增长：自动续播时才不会绕回刷过的歌。
       仅当"播放器队列尾部正是刷歌流尾部"才追加，避免把刷歌结果灌进别处的播放队列 */
    try {
      var q = Player.state && Player.state.queue
      if (q && q.length) {
        var tailKey = swipeKeyOf(q[q.length - 1])
        if (baseLen > 0 && tailKey && swipeKeyOf(swipeState.list[baseLen - 1]) === tailKey) {
          Player.addToQueue(list)
        }
      }
    } catch (e) {}
    return list.length
  }

  /** 剩余不足时后台静默预取，正常滑动不会撞到"后面没有更多了" */
  function swipeMaybePrefetch() {
    if (swipeState.filling || swipePool.empty) return
    if (swipeState.list.length - 1 - swipeState.idx > SWIPE_PREFETCH) return
    swipeFeedMore(SWIPE_BATCH)
  }

  function loadSwipeFeed(reset) {
    if (swipeState.loading) return swipeState.loading
    if (swipeState.loaded && !reset && swipeState.list.length) return Promise.resolve(swipeState.list)
    swipeState.loading = loadSwipeTaste(!!reset).then(function () {
      swipePoolBuild()
      swipeTasksBuild()
      swipeState.list = []
      swipeState.idx = 0
      swipeState.loaded = true
      return swipeFeedMore(SWIPE_BATCH)
    }).then(function () {
      swipeState.loading = null
      if (!swipeState.list.length) {
        /* 兜底：每日数据缺失或全部刷完时用搜索热词 */
        return API.search('热门', 1, 20).then(function (res) {
          var arr = (res.list || []).filter(function (s) {
            return s && s.name && (s.songmid || s.songId) && !swipeIsSeen(s)
          })
          swipeState.list = arr
          renderSwipe()
          if (arr.length && onSwipePage()) playSwipeCurrent()
        }).catch(function () {})
      }
      renderSwipe()
      if (onSwipePage()) playSwipeCurrent()
      return swipeState.list
    }).catch(function (e) {
      swipeState.loading = null
      if (window.console) console.warn('[swipe] 初始化失败: ' + e)
    })
    return swipeState.loading
  }

  function swipeShuffle() {
    if (swipeState.shuffling) return
    swipeState.shuffling = true
    loadSwipeTaste(true).then(function () {
      /* 口味可能刚变化（刚喜欢/刚听完），整池重算权重并重排 */
      swipePool.all.forEach(function (s) { s.__w = swipeWeightOf(s, s.__wbase || 1) })
      swipeRankFrom(0)
      swipePool.cursor = 0
      swipePool.empty = false
      swipeState.list = []
      swipeState.idx = 0
      return swipeFeedMore(SWIPE_BATCH)
    }).then(function () {
      swipeState.shuffling = false
      flip.active = false
      flip.busy = false
      if (!swipeState.list.length) {
        toast('暂时没有更多推荐了')
        renderSwipe()
        return
      }
      renderSwipe()
      playSwipeCurrent()
      toast('已换一批')
    }).catch(function () {
      swipeState.shuffling = false
      toast('换一批失败')
    })
  }


  function playSwipeCurrent() {
    var s = swipeState.list[swipeState.idx]
    if (!s) return
    Player.playList(swipeState.list, swipeState.idx)
  }

  /* 垂直翻页：拖动跟随 + 松手吸附/回弹（汽水式上下滑切歌）
     交互细节：拖动时卡片随手指位移并轻微缩放+减淡，音乐不中断；松手按位移/速度决定翻页或回弹 */
  var flip = { active: false, y0: 0, t0: 0, dy: 0, moved: false, busy: false, yLast: 0, tLast: 0, vy: 0 }

  function flipCard() {
    var box = $('#swipeScroll')
    return box ? box.querySelector('.swipe-card') : null
  }

  /* 当前是否停在刷歌页（决定切歌走翻页还是普通切歌） */
  function onSwipePage() {
    return document.body.getAttribute('data-tab') === 'swipe'
  }

  function flipReset(card) {
    if (!card) return
    card.style.transition = ''
    card.style.transform = ''
    card.style.opacity = ''
    card.style.filter = ''
    card.style.transformOrigin = ''
    card.classList.remove('dragging')
  }

  /* v3.7 拖动跟随：纸页顺着手指方向被"推"，不带反向错觉。
     上滑 = 前进（下一页从底部推入、当页顶上翻）；下滑 = 回翻（下一页从顶部落下、当页向下翻回）。
     旋转轴永远在手指前进方向的那一侧，因此视觉方向与手势方向一致。 */
  function flipApply(card, dy, h) {
    var p = Math.max(-1, Math.min(1, dy / (h || 1)))
    var damp = 1
    /* 首首/末首方向做阻尼，明确「到头了」 */
    if ((dy > 0 && swipeState.idx <= 0) || (dy < 0 && swipeState.idx >= swipeState.list.length - 1)) damp = 0.30
    var d = dy * 0.5 * damp
    var deg = p * 5 * damp
    card.style.transformOrigin = dy < 0 ? '50% 0%' : '50% 100%'
    card.style.transform = 'perspective(1400px) translate3d(0,' + d.toFixed(1) + 'px,0) rotateX(' +
      deg.toFixed(2) + 'deg) scale(' + (1 - Math.min(0.028, Math.abs(p) * 0.028)).toFixed(3) + ')'
    card.style.opacity = String((1 - Math.min(0.32, Math.abs(p) * 0.32)).toFixed(3))
  }

  function flipBack(card) {
    if (!card) return
    card.style.transition = 'transform .34s cubic-bezier(.22,.72,.28,1), opacity .26s ease'
    card.style.transform = 'perspective(1400px) translate3d(0,0,0) rotateX(0deg) scale(1)'
    card.style.opacity = '1'
    setTimeout(function () {
      flipReset(card)
      flip.busy = false
    }, 350)
  }

  /** 书本翻页切歌：
   *  1) 把当前页整页克隆成一张"纸"盖在最上层；
   *  2) 立刻换歌渲染新页——新页从第一帧就完整不透明地待在纸下面，因此不可能出现黑闪；
   *  3) 让纸绕上边（下一首）/下边（上一首）翻走，超过 90° 由 backface-visibility 收掉。
   */
  function flipTo(step) {
    if (flip.busy) return
    if (!swipeState.list.length) return
    var next = swipeState.idx + step
    /* v3.7：越界时把被手指推歪的卡片弹回原位，否则会定格在半透明偏移状态 */
    if (next < 0) {
      toast('已经是第一首')
      var cur0 = flipCard()
      if (cur0) {
        flip.busy = true
        flipBack(cur0)
      } else {
        flipReset(cur0)
      }
      return
    }
    /* v3.18 无限流：刷到流尾部不再提示"后面没有更多了"，
       先把卡片弹回原位，再补一批（池里没有就现拉数据），补到就自动继续翻 */
    if (next >= swipeState.list.length) {
      var curB = flipCard()
      if (curB) {
        flip.busy = true
        flipBack(curB)
      }
      if (swipeState.filling) return
      toast('正在获取更多推荐…')
      swipeFeedMore(SWIPE_BATCH).then(function (added) {
        if (added > 0) {
          setTimeout(function () {
            flip.busy = false
            flipTo(step)
          }, 260)
        } else {
          toast('已刷完全部可推荐歌曲')
        }
      })
      return
    }
    var box = $('#swipeScroll')
    var card = flipCard()
    if (!card || !box) {
      swipeState.idx = next
      swipeMarkSeen(swipeState.list[next])
      swipeSeenFlush()
      renderSwipe(true)
      playSwipeCurrent()
      swipeMaybePrefetch()
      return
    }
    var up = step > 0
    flip.busy = true

    /* 1) 克隆纸页：去掉 id 防止与真卡重复，尺寸位置与真卡严格一致 */
    var leaf = card.cloneNode(true)
    var ids = leaf.querySelectorAll('[id]')
    for (var i = 0; i < ids.length; i++) ids[i].removeAttribute('id')
    leaf.classList.add('swipe-leaf')
    leaf.setAttribute('aria-hidden', 'true')
    leaf.style.transition = 'none'
    leaf.style.transform = 'rotateX(0deg)'
    leaf.style.filter = 'brightness(1)'
    /* 纸页自带旧壁纸，翻起时连"纸"一起转走，而不是把内容层单独掀开放新页透出来 */
    var actWall = document.querySelector('#wallA.on') || document.querySelector('#wallB.on')
    if (actWall) {
      var bi = ''
      try { bi = window.getComputedStyle(actWall).backgroundImage } catch (err) { bi = '' }
      if (actWall.style.backgroundImage) bi = actWall.style.backgroundImage
      if (bi && bi !== 'none') {
        /* 纸页压暗必须轻：早期用 .84/.34/.92 会把整页压成灰黑，观感等同"一黑一闪" */
        leaf.style.backgroundImage = 'linear-gradient(180deg, rgba(8,10,13,.42) 0%, rgba(8,10,13,.14) 52%, rgba(8,10,13,.50) 100%), ' + bi
        leaf.style.backgroundSize = 'cover, cover'
        leaf.style.backgroundPosition = 'center, center'
        leaf.style.backgroundRepeat = 'no-repeat, no-repeat'
      } else {
        leaf.style.background = '#0b0d10'
      }
    } else {
      leaf.style.background = '#0b0d10'
    }
    var br = box.getBoundingClientRect()
    var cr = card.getBoundingClientRect()
    leaf.style.left = (cr.left - br.left) + 'px'
    leaf.style.top = (cr.top - br.top + box.scrollTop) + 'px'
    leaf.style.width = cr.width + 'px'
    leaf.style.height = cr.height + 'px'
    flipReset(card)

    /* 2) 换歌 + 渲染新页（纸下面的新页始终不透明） */
    swipeState.idx = next
    swipeMarkSeen(swipeState.list[next])
    swipeSeenFlush()
    renderSwipe(true)
    playSwipeCurrent()
    renderSwipeWall()
    swipeMaybePrefetch()

    /* 纸页必须在 renderSwipe 重建卡片之后再挂上，否则会被 innerHTML 覆盖掉 */
    box.appendChild(leaf)

    var nc = flipCard()
    if (nc) {
      /* 新页从手势来的方向顺势推入：上滑从底部推上来，下滑从顶部落回来 */
      var inCls = up ? 'page-in-up' : 'page-in-down'
      nc.classList.add(inCls)
      setTimeout(function () { nc.classList.remove(inCls) }, 520)
    }

    /* 3) 纸页翻走（内联 transition/transform，避免被初始内联 rotateX(0) 卡住）
       关键：新页封面图先预加载完再起翻，否则纸页掀起瞬间会露出还没加载的黑底封面，
       就是老板所说的"一黑"。纸页盖在上面，等图的这一两帧肉眼完全看不见。 */
    var started = false
    function startLeaf() {
      if (started) return
      started = true
      requestAnimationFrame(function () {
        /* v3.7：纸页绕"前进方向那一侧"的边翻走——上翻=顶边固定、底边向后掀起；
           回翻=底边固定、顶边向后掀下。旧版把原点放到了反向边，才会出现"反着翻"。 */
        leaf.style.transformOrigin = up ? '50% 0%' : '50% 100%'
        leaf.style.transition = 'none'
        leaf.style.transform = ''
        leaf.classList.add(up ? 'leaf-up' : 'leaf-down')
      })
    }
    var nextSong = swipeState.list[swipeState.idx]
    var coverSrc = nextSong && nextSong.img ? API.mediaUrl(nextSong.img, API.coverPx(420, 980)) : DEFAULT_COVER
    var pre = new Image()
    pre.onload = startLeaf
    pre.onerror = startLeaf
    pre.src = coverSrc
    setTimeout(startLeaf, 180)
    setTimeout(function () {
      if (leaf.parentNode) leaf.parentNode.removeChild(leaf)
      flip.busy = false
    }, 620)
  }

  /* v3.7：手势一起手就预热相邻曲目的封面与壁纸，
     松手瞬间图片已在内存解码，纸页能立即起翻，不再出现 100~180ms 的等待停顿 */
  function flipPreload(dir) {
    var t = swipeState.list[swipeState.idx + dir]
    if (!t) return
    if (!flip.warm) flip.warm = {}
    var key = dir + '|' + (t.img || t.name || '')
    if (flip.warm[key]) return
    flip.warm[key] = 1
    var c = new Image()
    c.src = t.img ? API.mediaUrl(t.img, API.coverPx(420, 980)) : DEFAULT_COVER
    try { if (c.decode) c.decode().catch(function () {}) } catch (err) {}
    if (t.img) {
      var w = new Image()
      w.src = API.mediaUrl(t.img, API.coverPx(600, 900))
      try { if (w.decode) w.decode().catch(function () {}) } catch (err2) {}
    }
  }

  /* v3.7.1：WebView 里 touchmove 一旦 preventDefault，Chrome 会把指针流 cancel 掉，
     pointermove 只收到一两帧，翻页判定随之中断（表现为"推不动/半途卡住"）。
     手势统一改走 touch 事件，Y 坐标从 touch 点数组里取。 */
  function ptY(e) {
    if (e.touches && e.touches.length) return e.touches[0].clientY
    if (e.changedTouches && e.changedTouches.length) return e.changedTouches[0].clientY
    return typeof e.clientY === 'number' ? e.clientY : 0
  }

  function flipDown(e) {
    if (flip.busy || e.button > 0) return
    var card = flipCard()
    if (!card) return
    flip.active = true
    flip.moved = false
    flip.dy = 0
    flip.vy = 0
    flip.y0 = ptY(e)
    flip.t0 = Date.now()
    flip.yLast = ptY(e)
    flip.tLast = flip.t0
    card.classList.add('dragging')
    flipPreload(1)
    flipPreload(-1)
  }

  function flipMove(e) {
    if (!flip.active) return
    var card = flipCard()
    if (!card) return
    var cy = ptY(e)
    flip.dy = cy - flip.y0
    /* 用最近一次位移增量估算瞬时速度（px/ms），松手时判断是否“甩动” */
    var now = Date.now()
    var dt = now - flip.tLast
    if (dt > 0) {
      flip.vy = (cy - flip.yLast) / dt
      flip.yLast = cy
      flip.tLast = now
    }
    if (!flip.moved) {
      if (Math.abs(flip.dy) < 8) return
      flip.moved = true
    }
    flipApply(card, flip.dy, card.clientHeight)
  }

  function flipUp() {
    if (!flip.active) return
    flip.active = false
    var card = flipCard()
    if (!card) return
    if (!flip.moved) { flipReset(card); return }
    var h = card.clientHeight || 1
    var passed = Math.abs(flip.dy) > h * 0.16
    var fast = Math.abs(flip.vy) > 0.55 && Math.abs(flip.dy) > 24
    if (passed || fast) {
      /* 手指上滑(dy<0) => 下一首 */
      flipTo(flip.dy < 0 ? 1 : -1)
    } else {
      flip.busy = true
      flipBack(card)
    }
    flip.dy = 0
    flip.vy = 0
  }

  function bindSwipeFlip() {
    var box = $('#swipeScroll')
    if (!box || box.__flipBound) return
    box.__flipBound = true
    if ('ontouchstart' in window) {
      /* v3.7.1：触摸设备只走 touch 通道。指针事件在 touchmove preventDefault 之后
         会被浏览器 cancel，导致翻页手势时断时续、手感发飘。 */
      box.addEventListener('touchstart', flipDown, { passive: true })
      box.addEventListener('touchmove', function (e) {
        if (e.cancelable) e.preventDefault()
        flipMove(e)
      }, { passive: false })
      box.addEventListener('touchend', flipUp)
      box.addEventListener('touchcancel', flipUp)
    } else {
      box.addEventListener('pointerdown', flipDown)
      box.addEventListener('pointermove', flipMove)
      box.addEventListener('pointerup', flipUp)
      box.addEventListener('pointercancel', flipUp)
      box.addEventListener('pointerleave', function () { if (flip.active) flipUp() })
    }
    window.addEventListener('resize', function () { positionSwipeSide(); flipReset(flipCard()) })
    window.addEventListener('orientationchange', function () { setTimeout(positionSwipeSide, 260) })
  }

  /** 右侧操作栏与封面垂直居中对齐（尺寸 390 宽下与封面右缘保持 ≥14px） */
  function positionSwipeSide() {
    var card = flipCard()
    if (!card) return
    var cover = card.querySelector('.swipe-cover')
    var side = card.querySelector('.swipe-side')
    if (!cover || !side) return
    var c = card.getBoundingClientRect()
    var cv = cover.getBoundingClientRect()
    var center = cv.top - c.top + cv.height / 2
    var half = side.offsetHeight / 2
    var min = half + 6
    var max = c.height - half - 6
    var y = Math.max(min, Math.min(max, center))
    side.style.top = y.toFixed(1) + 'px'
  }

  function swipeMove(step) {
    if (!swipeState.list.length) return
    flipTo(step)
  }

  function swipeCardHtml(s) {
    if (!s) return '<div class="empty">正在准备歌曲…</div>'
    var favorited = isFav(s)
    var cover = s.img ? API.mediaUrl(s.img, API.coverPx(420, 980)) : DEFAULT_COVER
    var cur = Player.current
    var playing = cur && cur.name === s.name && Player.state.playing
    return '' +
      '<div class="swipe-card">' +
        /* v54：整卡点击 = 暂停/播放（内部按钮与进度条各自 stopPropagation，互不干扰） */
        '<div class="swipe-main" data-act="swipe-toggle">' +
          /* v53：仿首页播放页结构 —— 歌名在上、海报居中、歌词在下 */
          '<div class="swipe-song">' +
            '<div class="swipe-name">' + esc(s.name) + '</div>' +
            '<div class="swipe-singer">' + esc(s.singer || '未知歌手') + '</div>' +
          '</div>' +
          '<button class="swipe-cover" type="button" data-act="toggle-play" aria-label="播放/暂停">' +
            '<img src="' + esc(cover) + '" alt="" onerror="this.src=\'' + DEFAULT_COVER + '\'">' +
            /* v54：暂停态中央浮出播放三角，播放态隐去（显隐交给 .page.playing 控制） */
            '<span class="swipe-pause-badge" aria-hidden="true">' + ico('i-play') + '</span>' +
          '</button>' +
          '<div class="swipe-lyric" aria-hidden="true">' +
            '<div class="swipe-lyric-box" id="swipeLyricBox"></div>' +
          '</div>' +
          /* v3.6：喜欢/收藏从右侧竖排移到歌名下方；下载与更多按钮按要求移除 */
          '<div class="swipe-actions">' +
            '<button class="sw-act' + (favorited ? ' on' : '') + '" type="button" data-act="swipe-fav" aria-label="喜欢">' +
              ico(favorited ? 'i-heart-fill' : 'i-heart') + '<span>喜欢</span></button>' +
            '<button class="sw-act" type="button" data-act="swipe-fav-add" aria-label="收藏">' +
              ico('i-plus') + '<span>收藏</span></button>' +
          '</div>' +
          /* v3.8：刷歌页进度条改为可拖动（原来只有一条纯展示的填充，无法快进/回退） */
          '<div class="swipe-prog" id="swipeProg">' +
            '<div class="swipe-prog-bar" id="swipeBar" role="slider" aria-label="播放进度">' +
              '<i id="swipeProgFill"></i><b class="swipe-knob" id="swipeKnob"></b></div>' +
            '<div class="swipe-prog-t"><span id="swipeCur">00:00</span><span id="swipeDur">00:00</span></div></div>' +
        '</div>' +
      '</div>'
  }

  /* ---------------- 刷歌页全屏壁纸 ----------------
     双层交替 + 预加载完成后才淡入：切歌时旧壁纸一直在，新图加载完再交叉淡入，
     既铺满全屏也不会出现"一黑"的过渡 */
  var wall = { front: 'wallA', cur: '' }

  function renderSwipeWall() {
    var a = $('#wallA')
    var b = $('#wallB')
    if (!a || !b) return
    var s = swipeState.list[swipeState.idx]
    var src = s && s.img ? API.mediaUrl(s.img, API.coverPx(600, 900)) : ''
    if (!src) {
      a.classList.remove('on')
      b.classList.remove('on')
      wall.cur = ''
      return
    }
    if (src === wall.cur) return
    var nxt = wall.front === 'wallA' ? b : a
    var old = wall.front === 'wallA' ? a : b
    var probe = new Image()
    probe.onload = function () {
      nxt.style.backgroundImage = 'url("' + src + '")'
      void nxt.offsetWidth
      nxt.classList.add('on')
      old.classList.remove('on')
      wall.front = (nxt.id === 'wallA') ? 'wallA' : 'wallB'
      wall.cur = src
    }
    probe.onerror = function () {}
    probe.src = src
  }

  function renderSwipe(resetScroll) {
    var box = $('#swipeScroll')
    if (!box) return
    if (!swipeState.list.length) {
      box.innerHTML = '<div class="loading"><span class="spin"></span><span>正在准备推荐…</span></div>'
      return
    }
    box.innerHTML = swipeCardHtml(swipeState.list[swipeState.idx])
    if (resetScroll) box.scrollTop = 0
    positionSwipeSide()
    bindSwipeFlip()
    bindSwipeBar()
    renderSwipeWall()
    renderProgress()
    renderSwipeLyric()
  }

  /** 刷歌页进度条拖动（v3.8）：跟手预览 + 松手 seek 一次，并拦住外层上下滑翻页手势 */
  function bindSwipeBar() {
    var bar = $('#swipeBar')
    if (!bar || bar.__barBound) return
    bar.__barBound = true
    var drag = false
    var lastPct = 0
    var at = function (ev) {
      var rect = bar.getBoundingClientRect()
      var tp = (ev.touches && ev.touches.length) ? ev.touches[0]
        : ((ev.changedTouches && ev.changedTouches.length) ? ev.changedTouches[0] : ev)
      var x = (tp.clientX || 0) - rect.left
      return Math.max(0, Math.min(1, x / (rect.width || 1)))
    }
    var preview = function (p) {
      lastPct = p
      bar.classList.add('dragging')
      var f = $('#swipeProgFill')
      if (f) f.style.width = (p * 100) + '%'
      var k = $('#swipeKnob')
      if (k) k.style.left = (p * 100) + '%'
      var c = $('#swipeCur')
      if (c) c.textContent = fmtTime(p * (Player.state.duration || 0))
    }
    var down = function (ev) {
      drag = true
      scrub.swipe = true
      if (ev.stopPropagation) ev.stopPropagation()
      preview(at(ev))
    }
    var move = function (ev) {
      if (!drag) return
      if (ev.stopPropagation) ev.stopPropagation()
      if (ev.cancelable) ev.preventDefault()
      preview(at(ev))
    }
    var up = function (ev) {
      if (!drag) return
      drag = false
      if (ev && ev.stopPropagation) ev.stopPropagation()
      bar.classList.remove('dragging')
      var d = Player.state.duration || 0
      scrub.swipe = false
      if (d > 0) Player.seek(lastPct * d)
      renderProgress()
    }
    bar.addEventListener('touchstart', down, { passive: true })
    bar.addEventListener('touchmove', move, { passive: false })
    bar.addEventListener('touchend', up)
    bar.addEventListener('touchcancel', up)
    bar.addEventListener('mousedown', function (ev) {
      down(ev)
      var mv = function (e2) { move(e2) }
      var mu = function () {
        document.removeEventListener('mousemove', mv)
        document.removeEventListener('mouseup', mu)
        up(null)
      }
      document.addEventListener('mousemove', mv)
      document.addEventListener('mouseup', mu)
    })
    /* 点一下进度条不应触发卡片上的播放/暂停 */
    bar.addEventListener('click', function (ev) { ev.stopPropagation() })
  }

  /** v41：首页迷你播放条进度可拖动（点按跳转 + 拖动 seek），并拦住外层「打开播放页」 */
  function bindMiniBar() {
    var box = document.querySelector('#mini .mini-progress')
    var fill = $('#miniBar')
    if (!box || !fill || box.__mbBound) return
    box.__mbBound = true
    var drag = false
    var lastPct = 0
    var at = function (ev) {
      var rect = box.getBoundingClientRect()
      var tp = (ev.touches && ev.touches.length) ? ev.touches[0]
        : ((ev.changedTouches && ev.changedTouches.length) ? ev.changedTouches[0] : ev)
      var x = (tp.clientX || 0) - rect.left
      return Math.max(0, Math.min(1, x / (rect.width || 1)))
    }
    var preview = function (p) {
      lastPct = p
      fill.classList.add('dragging')
      fill.style.width = (p * 100) + '%'
    }
    var down = function (ev) {
      drag = true
      scrub.mini = true
      if (ev.stopPropagation) ev.stopPropagation()
      preview(at(ev))
    }
    var move = function (ev) {
      if (!drag) return
      if (ev.stopPropagation) ev.stopPropagation()
      if (ev.cancelable) ev.preventDefault()
      preview(at(ev))
    }
    var up = function (ev) {
      if (!drag) return
      drag = false
      if (ev && ev.stopPropagation) ev.stopPropagation()
      fill.classList.remove('dragging')
      var d = Player.state.duration || 0
      scrub.mini = false
      if (d > 0) Player.seek(lastPct * d)
      renderProgress()
    }
    box.addEventListener('touchstart', down, { passive: true })
    box.addEventListener('touchmove', move, { passive: false })
    box.addEventListener('touchend', up)
    box.addEventListener('touchcancel', up)
    box.addEventListener('mousedown', function (ev) {
      down(ev)
      var mv = function (e2) { move(e2) }
      var mu = function () {
        document.removeEventListener('mousemove', mv)
        document.removeEventListener('mouseup', mu)
        up(null)
      }
      document.addEventListener('mousemove', mv)
      document.addEventListener('mouseup', mu)
    })
    box.addEventListener('click', function (ev) { ev.stopPropagation() })
  }

  function openSwipe() {
    if (!swipeState.loaded) loadSwipeFeed()
    renderSwipe()
    var cur = Player.current
    var s = swipeState.list[swipeState.idx]
    /* 当前未播放或播放的不是刷歌当前曲时，自动播当前首（切歌即换） */
    if (s) {
      swipeMarkSeen(s)
      swipeSeenFlush()
      if (!cur || cur.name !== s.name) playSwipeCurrent()
    }
    swipeMaybePrefetch()
  }

  /** 轻量刷新刷歌页的播放状态图标（不重建整张卡片，避免闪烁） */
  function updateSwipeState() {
    var box = $('#swipeScroll')
    if (!box || !box.querySelector('.swipe-card')) return
    var st = Player.state
    var s = swipeState.list[swipeState.idx]
    var playing = !!(s && Player.current && Player.current.name === s.name && st.playing)
    var swPage = document.querySelector('.page[data-page="swipe"]')
    if (swPage) swPage.classList.toggle('playing', playing)
    var icon = ico(playing ? 'i-pause' : 'i-play')
    var btn = box.querySelector('.swipe-playbtn')
    if (btn) setBtnIcon(btn, playing ? 'i-pause' : 'i-play')
    var main = box.querySelector('.swipe-ctrl .sctrl.main')
    if (main) setBtnIcon(main, playing ? 'i-pause' : 'i-play')
    var favBtn = box.querySelector('.sw-act[data-act="swipe-fav"]')
    if (favBtn) {
      var fOn = !!(s && isFav(s))
      favBtn.classList.toggle('on', fOn)
      /* v3.11：点过喜欢只留实心小红心，图标随状态切换 */
      setBtnIcon(favBtn, fOn ? 'i-heart-fill' : 'i-heart')
    }
  }

  /* ---------------- 歌手详情 ---------------- */
  function openArtist(name) {
    if (!name) return
    detailMeta = { type: 'artist', id: '', name: name, sub: '歌手' }
    $('#detailTitle').textContent = name
    openPanel('detail')
    detailLoading('正在加载歌手歌曲…')
    API.search(name, 1, 30).then(function (res) {
      var list = (res.list || []).filter(function (s) {
        return String(s.singer || '').indexOf(name) >= 0
      })
      if (!list.length) list = res.list || []
      detailSongs = list
      detailMeta.sub = '共 ' + list.length + ' 首 · 每日同步'
      renderDetail()
    }).catch(function (e) { detailError(e.message, 'detail-retry') })
  }


  /* ---------------- v3.10 我的下载（本地下载音频：查看 / 播放 / 删除） ---------------- */
  var dlState = { list: [], dir: '' }

  function fmtSize(n) {
    n = Number(n) || 0
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB'
    return (n / 1024 / 1024).toFixed(1) + ' MB'
  }

  function fmtDlDate(ms) {
    var d = new Date(Number(ms) || Date.now())
    function p(x) { return (x < 10 ? '0' : '') + x }
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function dlSongOf(item) {
    var raw = String((item && item.name) || '')
    var nm = raw.replace(/\.[^.]+$/, '')
    var parts = nm.split(' - ')
    var singer = parts.length > 1 ? parts[0].trim() : '本地下载'
    var name = parts.length > 1 ? parts.slice(1).join(' - ').trim() : nm
    return {
      name: name || nm || raw,
      singer: singer,
      source: 'local',
      localUrl: API.downloadFileUrl(raw),
      localPath: raw,
    }
  }

  function dlOpen() {
    var el = $('#dlPanel')
    if (!el) return
    el.classList.add('open')
    el.setAttribute('aria-hidden', 'false')
    document.body.classList.add('panel-open')
    dlDirty = true
    renderDl()
  }

  function dlClose() {
    var el = $('#dlPanel')
    if (!el) return
    dlStopPoll()
    el.classList.remove('open')
    el.setAttribute('aria-hidden', 'true')
    var others = $('#detailPanel').classList.contains('open') ||
      $('#searchPanel').classList.contains('open') ||
      $('#importPanel').classList.contains('open')
    if (!others) document.body.classList.remove('panel-open')
  }

  /* v3.11：下载中 / 已下载 分组渲染，面板打开期间自动轮询进度 */
  var dlPollTimer = null
  var dlDirty = true

  function dlStopPoll() {
    if (dlPollTimer) { clearTimeout(dlPollTimer); dlPollTimer = null }
  }

  function dlSchedulePoll(hasActive) {
    dlStopPoll()
    var el = $('#dlPanel')
    if (!el || !el.classList.contains('open')) return
    dlPollTimer = setTimeout(function () { renderDl(true) }, hasActive ? 700 : 3000)
  }

  function dlPct(t) {
    var total = Number(t && t.total) || 0
    var got = Number(t && t.received) || 0
    if (!total || !got) return -1
    return Math.max(1, Math.min(100, Math.round(got / total * 100)))
  }

  function dlTaskRow(t) {
    var sg = t.song || {}
    var pct = dlPct(t)
    var fail = t.status === 'error'
    var sub
    if (fail) sub = '下载失败：' + (t.error || '未知错误')
    else if (pct < 0) sub = '正在连接音源…'
    else sub = '正在下载 ' + pct + '% · ' + fmtSize(t.received) + (t.total ? ' / ' + fmtSize(t.total) : '')
    return '<div class="dl-row dl-row-run' + (fail ? ' dl-row-fail' : '') + '">' +
        '<span class="dl-ico dl-ico-run">' + ico('i-download') + '</span>' +
        '<span class="dl-meta">' +
          '<span class="dl-name">' + esc(sg.name || '未知歌曲') + '</span>' +
          '<span class="dl-sub">' + esc((sg.singer ? sg.singer + ' · ' : '') + sub) + '</span>' +
          (fail || pct < 0 ? '' : '<span class="dl-prog"><i style="width:' + pct + '%"></i></span>') +
        '</span>' +
      '</div>'
  }

  function renderDl(silent) {
    var body = $('#dlBody')
    var sum = $('#dlSum')
    if (!body) return
    if (!silent) body.innerHTML = '<div class="dl-empty">读取中…</div>'
    Promise.all([
      API.downloadList().catch(function (e) { return { __err: e, list: [], dir: '' } }),
      API.downloadTasks().catch(function () { return { list: [] } })
    ]).then(function (r) {
      var res = r[0] || {}
      var tasks = (r[1] && r[1].list) || []
      var list = res.list || []
      dlState.list = list
      if (res.dir) dlState.dir = res.dir
      var active = tasks.filter(function (t) { return t.status === 'pending' || t.status === 'running' })
      var failed = tasks.filter(function (t) { return t.status === 'error' }).slice(0, 3)

      var sumText = list.length
        ? '共 ' + list.length + ' 首 · ' + fmtSize(res.total)
        : ''
      if (active.length) sumText += (sumText ? ' · ' : '') + active.length + ' 个下载中'
      if (sum) sum.textContent = sumText

      var cell = $('#cellDlCount')
      if (cell) cell.textContent = (list.length ? list.length + ' 首' : '0 首') + (active.length ? ' · 下载中 ' + active.length : '')

      var html = ''
      if (active.length || failed.length) {
        html += '<div class="dl-group">下载中' + (active.length + failed.length > 1 ? ' ' + (active.length + failed.length) : '') + '</div>'
        html += active.concat(failed).map(dlTaskRow).join('')
      }

      if (list.length) html += '<div class="dl-group">已下载 ' + list.length + ' 首</div>'
      if (list.length) {
        html += list.map(function (it, i) {
          var sg = dlSongOf(it)
          return '<div class="dl-row" data-act="dl-play" data-index="' + i + '">' +
              '<span class="dl-ico">' + ico('i-play') + '</span>' +
              '<span class="dl-meta">' +
                '<span class="dl-name">' + esc(sg.name) + '</span>' +
                '<span class="dl-sub">' + esc(sg.singer) + ' · ' + fmtSize(it.size) + ' · ' + fmtDlDate(it.mtime) + '</span>' +
              '</span>' +
              '<button class="dl-del" type="button" data-act="dl-remove" data-index="' + i + '" aria-label="删除">' + ico('i-trash') + '</button>' +
            '</div>'
        }).join('')
      } else {
        html += '<div class="dl-empty">暂无下载</div>'
      }

      if (res.__err) {
        if (sum) sum.textContent = '读取失败'
        body.innerHTML = '<div class="dl-empty">读取下载列表失败：' + esc(res.__err.message || '未知错误') + '</div>'
        return
      }
      body.innerHTML = html
      dlDirty = false
      dlSchedulePoll(active.length > 0)
    }).catch(function (e) {
      if (sum) sum.textContent = '读取失败'
      body.innerHTML = '<div class="dl-empty">读取下载列表失败：' + esc(e && e.message ? e.message : '未知错误') + '</div>'
      dlSchedulePoll(false)
    })
  }

  /* ---------------- 我的 ---------------- */
  /* ---------------- v45：我的页个人资料（头像 / 昵称） ----------------
     存 localStorage：卸载前一直有效，不依赖服务端；头像先缩到 256×256 再压缩成
     JPEG dataURL，避免原图几 MB 直接把 WebView 的 5MB 配额打满。 */
  var PROFILE_KEY = 'chengying.profile'
  var profile = { avatar: '', name: '' }

  ;(function loadProfile() {
    try {
      var raw = localStorage.getItem(PROFILE_KEY)
      if (!raw) return
      var o = JSON.parse(raw)
      if (!o || typeof o !== 'object') return
      profile.avatar = typeof o.avatar === 'string' ? o.avatar : ''
      profile.name = typeof o.name === 'string' ? o.name : ''
    } catch (e) {}
  })()

  function profileSave() {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify({ avatar: profile.avatar, name: profile.name }))
    } catch (e) {
      toast('保存失败：本机存储空间不足')
    }
    renderMine()
  }

  function openAvatarSheet() {
    sheetOpen('更换头像',
      '<div class="chips">' +
        '<button class="chip" type="button" data-act="avatar-pick">从相册选择</button>' +
        '<button class="chip" type="button" data-act="avatar-reset">恢复默认头像</button>' +
      '</div>')
  }

  /* 走系统相册：Android 端由 MainActivity.onShowFileChooser 接手 */
  function pickAvatar() {
    sheetClose()
    var inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = 'image/*'
    inp.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0'
    function done() {
      if (inp.parentNode) inp.parentNode.removeChild(inp)
    }
    inp.onchange = function () {
      var f = inp.files && inp.files[0]
      if (!f) { done(); return }
      var fr = new FileReader()
      fr.onload = function () {
        var im = new Image()
        im.onload = function () {
          try {
            var S = 256
            var side = Math.min(im.width || S, im.height || S)
            var cv = document.createElement('canvas')
            cv.width = S
            cv.height = S
            var ctx = cv.getContext('2d')
            ctx.drawImage(im, ((im.width || side) - side) / 2, ((im.height || side) - side) / 2, side, side, 0, 0, S, S)
            profile.avatar = cv.toDataURL('image/jpeg', 0.86)
          } catch (e) {
            profile.avatar = String(fr.result || '')
          }
          done()
          profileSave()
          toast('头像已更换')
        }
        im.onerror = function () { done(); toast('这张图片读不出来') }
        im.src = String(fr.result || '')
      }
      fr.onerror = function () { done(); toast('读取图片失败') }
      fr.readAsDataURL(f)
    }
    document.body.appendChild(inp)
    inp.click()
  }

  function renderMine() {
    var box = $('#mineScroll')
    var favCount = lib.favorites.length
    var plCount = lib.playlists.length
    var pls = lib.playlists.map(function (p) {
      return '<button class="pl-row" type="button" data-act="open-mylist" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">' +
          '<span class="pl-cover">' + ico('i-list') + '</span>' +
          '<span class="pl-main"><span class="pl-name">' + esc(p.name) + '</span>' +
            '<span class="pl-sub">' + (p.songs ? p.songs.length : 0) + ' 首</span></span>' +
          ico('i-down', 'cell-arrow') +
        '</button>'
    }).join('')

    box.innerHTML = '' +
      '<div class="profile">' +
        '<div class="pc-top">' +
          /* v45：头像/昵称改为可编辑（头像从系统相册选，昵称弹窗改），存 localStorage */
          /* v3.16：去掉头像"+“角标与昵称旁“改名”字样，直接点头像/点名字即改 */
          '<button class="pc-avatar" type="button" data-act="mine-avatar" aria-label="点击更换头像">' +
            '<img id="pcAvatarImg" class="' + (profile.avatar ? '' : 'is-default') + '" src="' + esc(profile.avatar || 'img/qq/logo.png') + '" alt="">' +
          '</button>' +
          '<div class="pc-meta">' +
            '<div class="pc-name" data-act="mine-rename" role="button" tabindex="0" aria-label="点击修改昵称">' +
              '<span class="pc-name-txt">' + esc(profile.name || '本地音悦') + '</span>' +
            '</div>' +
            '<div class="pc-sub">QQ音乐·本地版 · 数据存于本机</div>' +
          '</div>' +
        '</div>' +
        '<div class="stat-row">' +
          '<button class="stat" type="button" data-act="open-fav"><b>' + favCount + '</b><span>我喜欢</span></button>' +
          '<button class="stat" type="button" data-act="open-history"><b id="statHistory">-</b><span>最近播放</span></button>' +
          '<button class="stat" type="button" data-act="open-newlist"><b>' + plCount + '</b><span>自建歌单</span></button>' +
        '</div>' +
      '</div>' +
      /* 同屏去重：最近播放已由上方统计入口承担，此处不再重复放同名 cell */
      '<div class="cell-group">' +
        '<button class="cell" type="button" data-act="open-queue"><span class="cell-ico">' + ico('i-queue') + '</span>' +
          '<span class="cell-label">播放队列</span><span class="cell-value" id="cellQueueCount">0 首</span>' + ico('i-down', 'cell-arrow') + '</button>' +
        '<button class="cell" type="button" data-act="open-downloads"><span class="cell-ico">' + ico('i-download') + '</span>' +
          '<span class="cell-label">我的下载</span><span class="cell-value" id="cellDlCount">查看</span>' + ico('i-down', 'cell-arrow') + '</button>' +
        '<button class="cell" type="button" data-act="open-quality"><span class="cell-ico">' + ico('i-note') + '</span>' +
          '<span class="cell-label">音质设置</span><span class="cell-value" id="cellQuality">' + esc(Player.state.quality) + '</span>' + ico('i-down', 'cell-arrow') + '</button>' +
        '<button class="cell" type="button" data-act="import-open"><span class="cell-ico">' + ico('i-plus') + '</span>' +
          '<span class="cell-label">导入歌单</span><span class="cell-value">QQ/网易云/酷狗</span>' + ico('i-down', 'cell-arrow') + '</button>' +
      '</div>' +
      '<section class="sec">' +
        '<div class="sec-head"><div class="sec-title">下载</div>' +
          '<button class="sec-more" type="button" data-act="open-downloads">管理</button></div>' +
        '<div class="mine-dl" id="mineDl"><div class="dl-empty">读取中…</div></div>' +
      '</section>' +
      '<section class="sec">' +
        '<div class="sec-head"><div class="sec-title">我的歌单</div>' +
          '<button class="sec-more" type="button" data-act="open-newlist">' + ico('i-plus') + '新建</button></div>' +
        '<div class="song-list">' + (pls || '<div class="empty">还没有歌单，点右上角新建</div>') + '</div>' +
      '</section>'

    updateMineStats()
  }

  function updateMineStats() {
    renderMineDl()
    var qc = $('#cellQueueCount')
    if (qc) qc.textContent = Player.state.queue.length + ' 首'
    var q = $('#cellQuality')
    if (q) q.textContent = realLabel(Player.state.realQuality || Player.state.quality)
    API.history().then(function (res) {
      var el = $('#statHistory')
      if (el) el.textContent = (res.list || []).length
    }).catch(function () {})
  }

  /* v3.11：我的页内嵌下载列表（下载中 + 已下载），下载进行中自动刷新 */
  var mineDlTimer = null

  function mineDlStop() {
    if (mineDlTimer) { clearTimeout(mineDlTimer); mineDlTimer = null }
  }

  function mineDlSongRow(it, i) {
    var sg = dlSongOf(it)
    return '<div class="dl-row" data-act="dl-play" data-index="' + i + '">' +
        '<span class="dl-ico">' + ico('i-play') + '</span>' +
        '<span class="dl-meta">' +
          '<span class="dl-name">' + esc(sg.name) + '</span>' +
          '<span class="dl-sub">' + esc(sg.singer) + ' · ' + fmtSize(it.size) + ' · ' + fmtDlDate(it.mtime) + '</span>' +
        '</span>' +
        '<button class="dl-del" type="button" data-act="dl-remove" data-index="' + i + '" aria-label="删除">' + ico('i-trash') + '</button>' +
      '</div>'
  }

  function renderMineDl() {
    var box = $('#mineDl')
    if (!box) return
    mineDlStop()
    Promise.all([
      API.downloadList().catch(function () { return { list: [], dir: '' } }),
      API.downloadTasks().catch(function () { return { list: [] } })
    ]).then(function (r) {
      var res = r[0] || {}
      var list = res.list || []
      var tasks = (r[1] && r[1].list) || []
      dlState.list = list
      if (res.dir) dlState.dir = res.dir
      var active = tasks.filter(function (t) { return t.status === 'pending' || t.status === 'running' })
      var failed = tasks.filter(function (t) { return t.status === 'error' }).slice(0, 2)

      var cnt = $('#cellDlCount')
      if (cnt) cnt.textContent = (list.length ? list.length + ' 首' : '0 首') + (active.length ? ' · 下载中 ' + active.length : '')

      var html = ''
      active.concat(failed).forEach(function (t) { html += dlTaskRow(t) })
      if (list.length) {
        list.slice(0, 6).forEach(function (it, i) { html += mineDlSongRow(it, i) })
        if (list.length > 6) {
          html += '<button class="dl-more" type="button" data-act="open-downloads">查看全部 ' + list.length + ' 首' +
            ico('i-down', 'cell-arrow') + '</button>'
        }
      } else if (!active.length && !failed.length) {
        html = '<div class="dl-empty">暂无下载</div>'
      }
      box.innerHTML = html
      if (active.length && document.querySelector('.page[data-page="mine"].active')) {
        mineDlTimer = setTimeout(renderMineDl, 900)
      }
    }).catch(function () {
      box.innerHTML = '<div class="dl-empty">读取失败</div>'
    })
  }

  /* ---------------- 详情面板 ---------------- */
  var detailSongs = []
  var detailMeta = { type: '', id: '', name: '' }

  function detailLoading(text) {
    $('#detailBody').innerHTML = '<div class="loading"><span class="spin"></span><span>' + esc(text || '正在加载…') + '</span></div>'
  }

  function detailError(msg, retryAct) {
    $('#detailBody').innerHTML =
      '<div class="errstate">' + ico('i-alert') +
        '<div class="err-title">加载失败</div>' +
        '<div class="err-sub">' + esc(msg || '请稍后重试') + '</div>' +
        (retryAct ? '<button class="err-retry" type="button" data-act="' + retryAct + '">重试</button>' : '') +
      '</div>'
  }

  function detailHero(opt) {
    var cover = opt.cover ? API.mediaUrl(opt.cover, API.coverPx(112, 260)) : DEFAULT_COVER
    return '' +
      '<div class="detail-hero">' +
        '<div class="detail-cover"><img src="' + esc(cover) + '" alt="" onerror="this.src=\'' + DEFAULT_COVER + '\'"></div>' +
        '<div class="detail-meta">' +
          '<div class="detail-name">' + esc(opt.name || '歌单') + '</div>' +
          '<div class="detail-sub">' + esc(opt.sub || '') + '</div>' +
          '<div class="detail-acts">' +
            '<button class="btn primary" type="button" data-act="play-all">' + ico('i-play') + '播放全部</button>' +
            (opt.type === 'mylist' ? '<button class="btn" type="button" data-act="mylist-rename">重命名</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>'
  }

  function renderDetail() {
    var songs = detailSongs
    var head = detailHero(detailMeta)
    var body = head + (songs.length ? songListShell(songs) : '<div class="empty">暂无歌曲</div>')
    $('#detailBody').innerHTML = body
    if (songs.length) Player.warm(songs, 3)
  }

  function openToplist(id, name) {
    detailMeta = { type: 'toplist', id: id, name: name || '排行榜' }
    $('#detailTitle').textContent = detailMeta.name
    openPanel('detail')
    detailLoading('正在加载榜单…')
    API.toplist(id, 1, 80).then(function (res) {
      detailSongs = res.list || []
      detailMeta.name = res.name || detailMeta.name
      detailMeta.cover = res.img || (res.info && res.info.img) || ''
      var parts = []
      if (res.updateTime) parts.push(res.updateTime)
      if (res.listenCount) parts.push(fmtCount(res.listenCount) + ' 人收听')
      parts.push(detailSongs.length + ' 首')
      detailMeta.sub = parts.join(' · ')
      $('#detailTitle').textContent = detailMeta.name
      renderDetail()
    }).catch(function (e) { detailError(e.message, 'detail-retry') })
  }

  function openPlaylist(id, name) {
    detailMeta = { type: 'playlist', id: id, name: name || '歌单' }
    $('#detailTitle').textContent = detailMeta.name
    openPanel('detail')
    detailLoading('正在加载歌单…')
    API.playlist(id).then(function (res) {
      detailSongs = res.songs || []
      detailMeta.name = res.name || detailMeta.name
      detailMeta.cover = res.cover || ''
      var sub = [res.creator, (res.listenCount ? fmtCount(res.listenCount) + ' 播放' : ''), detailSongs.length + ' 首'].filter(Boolean).join(' · ')
      detailMeta.sub = sub
      $('#detailTitle').textContent = detailMeta.name
      renderDetail()
    }).catch(function (e) {
      detailSongs = []
      detailError(e.message || '歌单不存在或不可访问', 'detail-retry')
    })
  }

  function openMyList(id, name) {
    var pl = null
    for (var i = 0; i < lib.playlists.length; i++) {
      if (String(lib.playlists[i].id) === String(id)) { pl = lib.playlists[i]; break }
    }
    detailMeta = { type: 'mylist', id: id, name: (pl && pl.name) || name || '我的歌单' }
    detailSongs = (pl && pl.songs) ? pl.songs.slice() : []
    detailMeta.sub = detailSongs.length + ' 首 · 本机歌单'
    $('#detailTitle').textContent = detailMeta.name
    openPanel('detail')
    renderDetail()
  }

  function openFav() {
    detailMeta = { type: 'fav', id: 'fav', name: '我喜欢', sub: lib.favorites.length + ' 首 · 本机收藏' }
    detailSongs = lib.favorites.slice()
    $('#detailTitle').textContent = '我喜欢'
    openPanel('detail')
    renderDetail()
  }

  function openHistory() {
    detailMeta = { type: 'history', id: 'history', name: '最近播放', sub: '' }
    $('#detailTitle').textContent = '最近播放'
    openPanel('detail')
    detailLoading('正在读取播放记录…')
    API.history().then(function (res) {
      detailSongs = res.list || []
      detailMeta.sub = detailSongs.length + ' 首 · 本机记录'
      renderDetail()
    }).catch(function (e) { detailError(e.message, 'detail-retry') })
  }

  function openRanking() {
    detailMeta = { type: 'ranking', id: 'ranking', name: '排行榜', sub: '' }
    $('#detailTitle').textContent = '排行榜'
    openPanel('detail')
    detailLoading('正在加载榜单…')
    API.toplists().then(function (res) {
      var list = res.list || []
      detailMeta.sub = list.length + ' 个榜单'
      var rows = list.map(function (t) {
        return '<button class="pl-row" type="button" data-act="open-toplist" data-id="' + t.id + '" data-name="' + esc(t.name) + '">' +
            '<span class="pl-cover"><img src="' + esc(t.img ? API.mediaUrl(t.img, API.coverPx(46, 160)) : DEFAULT_COVER) + '" alt="" loading="lazy" onerror="this.src=\'' + DEFAULT_COVER + '\'"></span>' +
            '<span class="pl-main"><span class="pl-name">' + esc(t.name) + '</span>' +
              '<span class="pl-sub">' + fmtCount(t.listenCount) + ' 人收听</span></span>' +
            ico('i-down', 'cell-arrow') +
          '</button>'
      }).join('')
      $('#detailBody').innerHTML = detailHero(detailMeta) + '<div class="song-list">' + rows + '</div>'
      detailSongs = []
    }).catch(function (e) { detailError(e.message, 'detail-retry') })
  }

  function openDaily() {
    detailMeta = { type: 'daily', id: 'daily', name: '每日推荐', sub: '' }
    $('#detailTitle').textContent = '每日推荐'
    openPanel('detail')
    detailLoading('正在挑选今日推荐…')
    API.toplists().then(function (r) {
      var list = r.list || []
      if (!list.length) throw new Error('暂无可用榜单数据')
      var pick = null
      list.forEach(function (t) { if (!pick && /热歌/.test(t.name || '')) pick = t })
      if (!pick) pick = list[0]
      return API.toplist(pick.id, 1, 30).then(function (res) {
        detailSongs = res.list || []
        detailMeta.name = res.name || pick.name
        detailMeta.cover = res.img || pick.img || ''
        detailMeta.sub = '每日精选 · ' + detailSongs.length + ' 首'
        $('#detailTitle').textContent = detailMeta.name
        renderDetail()
      })
    }).catch(function (e) { detailError(e.message, 'detail-retry') })
  }

  function refreshLists() {
    if ($('#detailPanel').classList.contains('open')) {
      if (detailMeta.type === 'fav') { detailSongs = lib.favorites.slice(); renderDetail() }
      if (detailMeta.type === 'mylist') openMyList(detailMeta.id, detailMeta.name)
    }
  }

  /* ---------------- 搜索 ---------------- */
  var searchState = { kw: '', platform: 'kw', page: 1, list: [], total: 0, loading: false }

  function renderSearchResults(append) {
    var box = $('#searchBody')
    if (!searchState.list.length) {
      box.innerHTML = '<div class="empty">没有找到相关歌曲</div>'
      return
    }
    var head = '<div class="sec-head"><div class="sec-title">搜索结果<em>' + searchState.total + ' 首</em></div>' +
      '<button class="sec-more" type="button" data-act="play-all-search">' + ico('i-play') + '播放全部</button></div>'
    var more = searchState.list.length < searchState.total
      ? '<button class="err-retry" type="button" data-act="search-more" style="margin:14px auto 0;display:block">加载更多</button>'
      : ''
    box.innerHTML = head + songListShell(searchState.list, { flush: true }) + more
  }

  function doSearch(append) {
    var kw = $('#searchInput').value.trim()
    if (!kw) { toast('请输入搜索关键词'); return }
    if (append) searchState.page++; else { searchState.page = 1; searchState.list = [] }
    searchState.kw = kw
    searchState.loading = true
    if (!append) $('#searchBody').innerHTML = '<div class="loading"><span class="spin"></span><span>正在搜索…</span></div>'
    API.search(kw, searchState.page, 30, searchState.platform).then(function (res) {
      searchState.total = res.total || 0
      searchState.list = append ? searchState.list.concat(res.list || []) : (res.list || [])
      searchState.loading = false
      renderSearchResults(append)
      Player.warm(searchState.list, 2)
    }).catch(function (e) {
      searchState.loading = false
      $('#searchBody').innerHTML =
        '<div class="errstate">' + ico('i-alert') +
          '<div class="err-title">搜索失败</div><div class="err-sub">' + esc(e.message) + '</div>' +
          '<button class="err-retry" type="button" data-act="search-submit">重试</button></div>'
    })
  }

  /* ---------------- 迷你播放器 ---------------- */
  function renderMini() {
    var st = Player.state
    var song = Player.current
    var mini = $('#mini')
    if (!mini) return
    var has = !!song
    /* 常驻：无论有无播放内容都显示，空态展示「未在播放」占位（二级页面也不例外） */
    mini.classList.add('show')
    mini.classList.toggle('idle', !has)
    mini.classList.toggle('playing', has && st.playing)
    mini.classList.toggle('buffering', !!(st.loading && has))
    mini.setAttribute('aria-hidden', 'false')
    $('#miniCover').src = song && song.img ? API.mediaUrl(song.img, API.coverPx(48, 160)) : DEFAULT_COVER_MINI
    $('#miniName').textContent = has ? (song.name || '未知歌曲') : '未在播放'
    $('#miniSinger').textContent = has ? (song.singer || '未知歌手') : '选择一首歌开始'
    $('#miniPlay').innerHTML = ico(st.playing ? 'i-pause' : 'i-play')
    /* v3.6：上一首可点性 + 纯图标小红心（实心红=已喜欢） */
    var pv = $('#miniPrev')
    if (pv) pv.classList.toggle('dim', !has)
    var fav = $('#miniFav')
    if (fav) {
      var favOn = !!(has && isFav(song))
      fav.classList.toggle('on', favOn)
      fav.setAttribute('aria-pressed', favOn ? 'true' : 'false')
      fav.innerHTML = ico(favOn ? 'i-heart-fill' : 'i-heart')
    }
    renderMiniBall()
  }

  /* ---------------- 我的页：漂浮播放球（v3.16） ----------------
     我的页隐藏底部迷你条，用一个可拖动的圆形小球替代：
     点击进播放页，拖动可换位置（位置记在 localStorage），无歌时隐藏。 */
  var BALL_POS_KEY = 'chengying.ballPos'

  function renderMiniBall() {
    var ball = $('#miniBall')
    if (!ball) return
    var st = Player.state
    var song = Player.current
    var onMine = document.body.getAttribute('data-tab') === 'mine'
    ball.classList.toggle('show', !!song && onMine)
    ball.classList.toggle('playing', !!(song && st.playing))
    ball.classList.toggle('buffering', !!(st.loading && song))
    ball.setAttribute('aria-hidden', song && onMine ? 'false' : 'true')
    var img = $('#miniBallCover')
    if (img) img.src = song && song.img ? API.mediaUrl(song.img, API.coverPx(48, 160)) : DEFAULT_COVER_MINI
    var ico2 = ball.querySelector('.mini-ball-ico use')
    if (ico2) ico2.setAttribute('href', st.playing ? '#i-pause' : '#i-play')
  }

  function bindMiniBall() {
    var ball = $('#miniBall')
    if (!ball || ball.__ballBound) return
    ball.__ballBound = true
    /* 恢复上次拖动位置 */
    var saved = null
    try { saved = JSON.parse(localStorage.getItem(BALL_POS_KEY) || 'null') } catch (e) { saved = null }
    var applyPos = function (x, y) {
      var w = innerWidth, h = innerHeight, s = 52
      x = Math.max(6, Math.min(w - s - 6, x))
      y = Math.max(60, Math.min(h - s - 70, y))
      ball.style.left = x + 'px'
      ball.style.top = y + 'px'
      ball.style.right = 'auto'
      ball.style.bottom = 'auto'
      return { x: x, y: y }
    }
    if (saved && typeof saved.x === 'number') applyPos(saved.x, saved.y)
    var drag = null
    ball.addEventListener('pointerdown', function (ev) {
      var r = ball.getBoundingClientRect()
      drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top, moved: false, t: Date.now() }
      ball.setPointerCapture && ball.setPointerCapture(ev.pointerId)
    })
    ball.addEventListener('pointermove', function (ev) {
      if (!drag) return
      if (!drag.moved && Math.abs(ev.clientX - (drag.dx + ball.getBoundingClientRect().left)) < 3) return
      drag.moved = true
      ball.classList.add('dragging')
      applyPos(ev.clientX - drag.dx, ev.clientY - drag.dy)
    })
    var end = function (ev) {
      if (!drag) return
      var moved = drag.moved
      drag = null
      ball.classList.remove('dragging')
      if (moved) {
        var r = ball.getBoundingClientRect()
        try { localStorage.setItem(BALL_POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })) } catch (e) {}
        /* 拖动结束后吞掉这次 click，避免误触打开播放页 */
        ball.__skipClick = Date.now()
      }
    }
    ball.addEventListener('pointerup', end)
    ball.addEventListener('pointercancel', end)
    ball.addEventListener('click', function (ev) {
      if (ball.__skipClick && Date.now() - ball.__skipClick < 400) {
        ev.stopPropagation()
        ev.preventDefault()
      }
    }, true)
  }

  /* 拖动进度条期间冻结自动刷新：否则 timeupdate 每 250ms 把滑块拽回真实播放位置，
     手指怎么拖都看着"拖不动"。拖动时只做本地预览，松手才真正 seek。 */
  var scrub = { bar: false, swipe: false, mini: false }

  function renderProgress(st2) {
    var st = Player.state
    var d = st.duration || 0
    var pct = d > 0 ? Math.min(100, (st.currentTime / d) * 100) : 0
    var bar = $('#miniBar')
    if (bar && !scrub.mini) bar.style.width = pct + '%'
    var fill = $('#barFill')
    var knob = $('#barKnob')
    var tc = $('#tCur')
    var td = $('#tDur')
    if (scrub.bar) {
      /* 拖动中：填充/滑块/已播时间由拖动逻辑独占，这里只更新总时长 */
      if (td) td.textContent = fmtTime(d)
    } else {
      if (fill) fill.style.width = pct + '%'
      if (knob) knob.style.left = pct + '%'
      if (tc) tc.textContent = fmtTime(st.currentTime)
      if (td) td.textContent = fmtTime(d)
    }
    /* 刷歌页进度条 */
    var sf = $('#swipeProgFill')
    var sc = $('#swipeCur')
    var sd = $('#swipeDur')
    if (scrub.swipe) {
      if (sd) sd.textContent = fmtTime(d)
    } else {
      if (sf) sf.style.width = pct + '%'
      /* v41：进度在走时刷歌页小圆球也要跟着走（此前只更新填充宽度，滑块卡住不动） */
      var sk = $('#swipeKnob')
      if (sk) sk.style.left = pct + '%'
      if (sc) sc.textContent = fmtTime(st.currentTime)
      if (sd) sd.textContent = fmtTime(d)
    }
    /* 卡拉OK 逐字跟唱 */
    syncKaraoke(st)
  }

  /** 汽水式逐字填充：把当前行文字做成「已唱/未唱」两段渐变裁切，边界随时间连续推进
   *  - 边界像素按每个字符真实位置插值，中英文混排也不会错位
   *  - 只在换行时做一次几何测量并按行缓存，拖动/缩放后失效重测
   */
  var karaoke = { idx: -1, geom: {}, raf: 0, dragUntil: 0, scrollRaf: 0 }

  function karaokeReset() {
    karaoke.idx = -1
    karaoke.geom = {}
    karaoke.fillSig = ''
    karaoke.cps = {}
  }

  /** 测量当前行字符栅格（以元素本地坐标为基准，抗 transform 缩放） */
  function lyricGeom(line, key) {
    if (karaoke.geom[key]) return karaoke.geom[key]
    var txt = line.querySelector('.lyric-txt')
    if (!txt) return null
    var ks = txt.querySelectorAll('.k')
    var base = txt.getBoundingClientRect()
    var scale = txt.offsetWidth ? (base.width / txt.offsetWidth) : 1
    if (!scale || !isFinite(scale)) scale = 1
    var xs = [], ws = [], sum = 0
    for (var i = 0; i < ks.length; i++) {
      var r = ks[i].getBoundingClientRect()
      xs.push((r.left - base.left) / scale)
      ws.push(r.width / scale)
      sum += r.width / scale
    }
    var g = { n: ks.length, xs: xs, ws: ws, w: sum }
    karaoke.geom[key] = g
    return g
  }

  /** 按进度逐字点亮一行歌词（v3.7）
   *  旧实现用横向像素渐变裁切，依赖字符的 getBoundingClientRect 横向坐标：
   *  一旦这一行折行、或字距/字号变化，句末几个字就落在渐变 100% 之外，
   *  表现为"末字一直是灰的、切行前半句没唱完"。改为按 .k 字符上色后，
   *  填充只跟字数走，与排版无关，整行一定能走满。 */
  function fillLyricLine(line, key, ratio, ns) {
    /* v3.19：ns 区分作用域——'pl'=播放页歌词（默认），'sw'=刷歌页封面歌词。
       两处共用同一套填字算法，但各自维护填充进度，互不串味。 */
    var store = (ns === 'sw') ? 'sw' : 'pl'
    var sigKey = store + '|' + key
    var txt = line.querySelector('.lyric-txt')
    if (!txt) return
    var ks = txt.querySelectorAll('.k')
    var n = ks.length
    if (!n) return
    var r = !isFinite(ratio) ? 0 : (ratio < 0 ? 0 : (ratio > 1 ? 1 : ratio))

    /* v3.8：不再「整字跳亮」。旧逻辑把 pos 取整，字一进入就整字变白，
       相当于永远提前半字，叠加 pace 偏快就形成"字跑在声音前面"。
       现在按连续字符位置给每个字单独的已唱比例 --cp（0~100），
       当前演唱的那个字内部用渐变边界平滑推进，整句与声音同步爬行。 */
    var pos = r * n
    var full = Math.floor(pos)
    var frac = Math.round((pos - full) * 100)
    if (frac >= 100) { full += 1; frac = 0 }
    if (full > n) full = n
    var done = (r >= 1)

    var sig = full + '|' + (done ? 100 : frac)
    if (karaoke.fillSig !== sigKey + '|' + sig) {
      var st = karaoke.cps || (karaoke.cps = {})
      var arr = st[sigKey] || (st[sigKey] = [])
      for (var i = 0; i < n; i++) {
        var el = ks[i]
        var cp = done ? 100 : (i < full ? 100 : (i === full ? frac : 0))
        if (arr[i] !== cp) {
          arr[i] = cp
          el.style.setProperty('--cp', cp)
        }
        /* .on 只作为"这一字已唱完"的语义标记，供已唱行整体降亮使用 */
        if (cp >= 100) { if (!el.classList.contains('on')) el.classList.add('on') }
        else if (el.classList.contains('on')) el.classList.remove('on')
        if (el.classList.contains('cur')) el.classList.remove('cur')
      }
      karaoke.fillSig = sigKey + '|' + sig
    }
    txt.style.setProperty('--ly-p', (r * 100).toFixed(2) + '%')
  }

  /** 平滑把当前行滚到歌词区中线（缓动，而不是瞬间跳） */
  function scrollLyricTo(box, line) {
    /* 用实时矩形差计算，抵消 padding / 行高差异，保证当前行精确落在歌词区中线 */
    var br = box.getBoundingClientRect()
    var lr = line.getBoundingClientRect()
    var target = box.scrollTop + (lr.top - br.top) - (box.clientHeight - lr.height) / 2
    var max = Math.max(0, box.scrollHeight - box.clientHeight)
    target = Math.max(0, Math.min(max, target))
    if (karaoke.scrollRaf) cancelAnimationFrame(karaoke.scrollRaf)
    /* 用户手动滑歌词时不抢滚动 */
    if (Date.now() < karaoke.dragUntil) { box.scrollTop = target; return }
    var from = box.scrollTop
    var dist = target - from
    if (Math.abs(dist) < 1) return
    var t0 = 0, dur = 180
    function step(ts) {
      if (!t0) t0 = ts
      var p = Math.min(1, (ts - t0) / dur)
      var e = 1 - Math.pow(1 - p, 3)
      box.scrollTop = from + dist * e
      if (p < 1) karaoke.scrollRaf = requestAnimationFrame(step)
      else karaoke.scrollRaf = 0
    }
    karaoke.scrollRaf = requestAnimationFrame(step)
  }

  /* ---------------- 跟唱对齐参数 ----------------
     LRC 时间戳是「这一行开始唱」的时刻。行内逐字填充若按 [本行, 下一行) 整段均摊，
     遇到句末长伴奏空拍就会在停顿里继续慢慢"填"，画面天然落后人声一拍。
     这里改为按字数估算真实演唱区间：唱完即填满，空拍期保持整行高亮，下一行到点再切行。 */
  var LYRIC_SYNC = {
    /* 视觉提前量（秒）：只补偿一点点调度延迟，不再按整段链路延迟提前。
       v3.7.2 的 0.32 让整行字整体抢在人声前面，表现就是"字还没唱到就亮了、跳得比唱快"。
       这里收到 0.12：既不抢拍，也不会因 rAF 取帧延迟显得拖后。 */
    lead: 0.12,
    /* 单字演唱时长估算（秒/字）：中文流行歌实际约 0.28~0.38s/字。
       v3.7.2 的 0.22 让一行 10 字只用 2.2s 就填满，若真实唱 4s，句子会先填满再干等 → "跳太快"。 */
    pace: 0.32,
    minSing: 0.60   /* 极短行最小演唱时长，避免一闪而过 */
  }
  /* 暴露给 player.js，保证「切行」与「填字」共用同一提前量 */
  window.__LYRIC_LEAD = LYRIC_SYNC.lead

  /** 估算一行歌词的演唱时长：字数 x pace，且不超过到下一行的间隔 */
  function lineSingDur(list, idx) {
    var start = list[idx].t || 0
    var next = (idx + 1 < list.length ? list[idx + 1].t : start + 99)
    var gap = Math.max(0.2, next - start)
    var txt = String(list[idx].text || '').replace(/[\s，。！？、,.!?—…·"'“”‘’（）()《》<>【】\[\]:：;；~～-]/g, '')
    var est = Math.max(LYRIC_SYNC.minSing, txt.length * LYRIC_SYNC.pace)
    /* 留 10% 余量：保证切行之前整句已经填满并亮一小段，不会"字没填完就跳走" */
    return Math.min(gap * 0.9, est)
  }

  /** 歌词跟唱主逻辑：t 可传音频真实时间（rAF 平滑）或 state 时间（进度事件） */
  function syncKaraoke(st, tOverride) {
    var list = (st && st.lyric) || []
    if (!list.length) return
    var box = $('#lyricList')
    if (!box || !box.childElementCount) return
    var t = (typeof tOverride === 'number' ? tOverride : (st.currentTime || 0)) + LYRIC_SYNC.lead
    var idx = -1
    for (var i = 0; i < list.length; i++) {
      if ((list[i].t || 0) <= t) idx = i
      else break
    }
    if (idx < 0) return
    var lines = $$('.lyric-line', box)
    var line = lines[idx]
    if (!line) return
    var start = list[idx].t || 0
    /* 填充窗口取「估算演唱时长」，而不是到下一行的整段间隔 */
    var sing = lineSingDur(list, idx)
    var ratio = Math.min(1, Math.max(0, (t - start) / Math.max(0.25, sing)))
    if (karaoke.idx !== idx) {
      /* 切行：上一行在切走瞬间补满（哪怕进度还差一点），绝不出现"半句灰字被跳过" */
      var prev = (karaoke.idx >= 0 && lines[karaoke.idx]) ? lines[karaoke.idx] : null
      for (var k = 0; k < lines.length; k++) {
        lines[k].classList.remove('active', 'singing')
      }
      if (prev) {
        fillLyricLine(prev, karaoke.idx, 1)
        prev.classList.add('sung')
      }
      karaoke.idx = idx
      line.classList.remove('sung')
      line.classList.add('active')
      scrollLyricTo(box, line)
    }
    line.classList.toggle('singing', ratio < 1)
    fillLyricLine(line, idx, ratio)
  }

  /* ---------------- 刷歌页封面歌词（v3.19） ----------------
     需求：刷歌页封面下沿那块区域直接显示当前歌曲歌词，随播放跟唱滚动。
     与播放页同一套算法（.lyric-line / .k 逐字填充 + lineSingDur 演唱时长估算），
     只是把行渲染到封面玻璃窗里，滚动窗 3 行高，靠 css/v51.css 控制视觉。 */
  var swipeKaraoke = { idx: -1 }

  function swipeLyricLineHtml(l, i) {
    var chars = String(l.text || '').split('').map(function (c) {
      return '<span class="k">' + (c === ' ' ? '&nbsp;' : esc(c)) + '</span>'
    }).join('')
    /* 刷歌页歌词只做展示，不带 data-act，避免误触 seek */
    return '<div class="lyric-line' + (l.tr ? ' has-tr' : '') + '" data-i="' + i + '">' +
      '<div class="lyric-txt">' + chars + '</div>' +
      (l.tr ? '<div class="tr">' + esc(l.tr) + '</div>' : '') +
      '</div>'
  }

  function renderSwipeLyric() {
    var box = $('#swipeLyricBox')
    if (!box) return
    var list = (Player.state && Player.state.lyric) || []
    swipeKaraoke.idx = -1
    if (!list.length) {
      var hint = (Player.state && Player.state.loading) ? '歌词加载中…' : '暂无歌词'
      box.innerHTML = '<div class="sw-ly-tip">' + hint + '</div>'
      return
    }
    box.innerHTML = list.map(swipeLyricLineHtml).join('')
    box.scrollTop = 0
    syncSwipeKaraoke(Player.state)
  }

  /** 刷歌页跟唱：与 syncKaraoke 同构，独立记录当前行，互不干扰 */
  function syncSwipeKaraoke(st, tOverride) {
    var list = (st && st.lyric) || []
    if (!list.length) return
    var box = $('#swipeLyricBox')
    if (!box || !box.childElementCount) return
    var t = (typeof tOverride === 'number' ? tOverride : (st.currentTime || 0)) + LYRIC_SYNC.lead
    var idx = -1
    for (var i = 0; i < list.length; i++) {
      if ((list[i].t || 0) <= t) idx = i
      else break
    }
    if (idx < 0) return
    var lines = $$('.lyric-line', box)
    var line = lines[idx]
    if (!line) return
    var start = list[idx].t || 0
    var sing = lineSingDur(list, idx)
    var ratio = Math.min(1, Math.max(0, (t - start) / Math.max(0.25, sing)))
    if (swipeKaraoke.idx !== idx) {
      var prev = (swipeKaraoke.idx >= 0 && lines[swipeKaraoke.idx]) ? lines[swipeKaraoke.idx] : null
      for (var k = 0; k < lines.length; k++) lines[k].classList.remove('active', 'singing')
      if (prev) {
        fillLyricLine(prev, swipeKaraoke.idx, 1, 'sw')
        prev.classList.add('sung')
      }
      swipeKaraoke.idx = idx
      line.classList.remove('sung')
      line.classList.add('active')
      swipeLyricTo(box, line)
    }
    line.classList.toggle('singing', ratio < 1)
    fillLyricLine(line, idx, ratio, 'sw')
  }

  /** 把小窗当前行滚到中线（窗口只有 3 行高，直接对齐即可，不需要长距离缓动） */
  function swipeLyricTo(box, line) {
    var br = box.getBoundingClientRect()
    var lr = line.getBoundingClientRect()
    var target = box.scrollTop + (lr.top - br.top) - (box.clientHeight - lr.height) / 2
    var max = Math.max(0, box.scrollHeight - box.clientHeight)
    box.scrollTop = Math.max(0, Math.min(max, target))
  }

  /** rAF 主循环：只在播放页可见且正在播放时推进，其余情况自动空转 */
  function karaokeFrame() {
    karaoke.raf = requestAnimationFrame(karaokeFrame)
    var onSwipe = document.body.getAttribute('data-tab') === 'swipe'
    var pl = $('#player')
    var onPlayer = !!(pl && pl.classList.contains('open'))
    if (!onPlayer && !onSwipe) return
    var a = Player.audio
    if (!a || a.paused || !isFinite(a.currentTime)) return
    if (onPlayer) syncKaraoke(Player.state, a.currentTime)
    if (onSwipe) syncSwipeKaraoke(Player.state, a.currentTime)
  }
  karaoke.raf = requestAnimationFrame(karaokeFrame)

  /** 歌词区拖动/滚轮时暂停自动居中一小段时间 */
  function bindLyricDrag() {
    var box = $('#lyricList')
    if (!box || box.__dragBound) return
    box.__dragBound = true
    var hold = function () { karaoke.dragUntil = Date.now() + 1600 }
    box.addEventListener('touchstart', hold, { passive: true })
    box.addEventListener('touchmove', hold, { passive: true })
    box.addEventListener('wheel', hold, { passive: true })
    window.addEventListener('resize', function () {
      karaokeReset()
      syncKaraoke(Player.state)
    })
  }


  /* 播放页唱片封面目标像素：按容器真实渲染尺寸 x DPR 计算，避免固定尺寸在 DPR2 下发虚 */
  function discCoverPx() {
    var el = $('#discCover')
    var w = el ? el.clientWidth : 0
    if (!w) {
      var wrap = $('.disc-wrap')
      w = wrap ? wrap.clientWidth : 0
    }
    if (!w) w = Math.min(288, window.innerWidth * 0.66)
    return API.coverPx(w, 600)
  }

  /* ---------------- 全屏播放页 ---------------- */
  function renderPlayerSong() {
    var song = Player.current
    $('#pName').textContent = song ? (song.name || '未知歌曲') : '未在播放'
    $('#pSinger').textContent = song ? (song.singer || '未知歌手') : '—'
    var cover = song && song.img ? API.mediaUrl(song.img, discCoverPx()) : DEFAULT_COVER_BIG
    var img = $('#discCover')
    /* 关键：只改 src，不碰宽高。容器 .disc 由 CSS 锁死 1:1，加载态仅叠加覆盖层 */
    img.onerror = function () { this.onerror = null; this.src = DEFAULT_COVER }
    img.src = cover
    var bg = $('#playerBg')
    if (bg) bg.style.backgroundImage = 'url("' + cover + '")'
    syncPlayerFav()
  }

  function syncPlayerFav() {
    var btn = $('#btnFav')
    if (!btn) return
    var on = isFav(Player.current)
    btn.classList.toggle('on', on)
    /* v3.10：纯红心（#i-heart-fill），点亮只切 class，不重写 innerHTML，避免冲掉点击波纹节点 */
  }

  function renderPlayerState() {
    var st = Player.state
    var playing = st.playing
    var busy = !!(st.loading && !st.playing)
    $('#player').classList.toggle('playing', playing)
    var swPage = document.querySelector('.page[data-page="swipe"]')
    if (swPage) swPage.classList.toggle('playing', playing)
    var btn = $('#btnPlay')
    if (btn) {
      setBtnIcon(btn, playing ? 'i-pause' : 'i-play')
      btn.classList.toggle('loading', busy)
    }
    var disc = $('#disc')
    if (disc) disc.classList.toggle('is-loading', busy)
    setBtnIcon($('#miniPlay'), playing ? 'i-pause' : 'i-play')
    $('#mini').classList.toggle('playing', playing)
    $('#mini').classList.toggle('buffering', !!(st.loading && Player.current))
    if (st.error && !playing) toast(st.error)
  }

  function lyricLineHtml(l, i) {
    var chars = String(l.text || '').split('').map(function (c) {
      return '<span class="k">' + (c === ' ' ? '&nbsp;' : esc(c)) + '</span>'
    }).join('')
    return '<div class="lyric-line' + (l.tr ? ' has-tr' : '') + '" data-act="lyric-seek" data-index="' + i + '">' +
      '<div class="lyric-txt">' + chars + '</div>' +
      (l.tr ? '<div class="tr">' + esc(l.tr) + '</div>' : '') +
      '</div>'
  }

  function renderLyric(index) {
    var list = Player.state.lyric || []
    var box = $('#lyricList')
    if (!box) return
    if (!list.length) {
      box.innerHTML = '<div class="lyric-empty">暂无歌词</div>'
      karaokeReset()
      return
    }
    if (box.childElementCount !== list.length) {
      box.innerHTML = list.map(lyricLineHtml).join('')
      karaokeReset()
    }
    /* v3.19：歌词变更同步刷新刷歌页封面歌词窗 */
    renderSwipeLyric()
    /* 换行、居中、逐字填充统一交给 syncKaraoke（几何缓存随行号失效） */
    if (index >= 0) syncKaraoke(Player.state)
  }


  function updateQueueSheet() {
    var st = Player.state
    if (!st.queue.length) { sheetOpen('播放队列', '<div class="empty">队列为空</div>'); return }
    var rows = st.queue.map(function (s, i) {
      var cur = i === st.index
      return '<div class="sheet-item' + (cur ? ' playing' : '') + '">' +
          '<span class="si-cover"><img src="' + esc(s.img ? API.mediaUrl(s.img, API.coverPx(40, 140)) : DEFAULT_COVER) + '" alt="" onerror="this.src=\'' + DEFAULT_COVER + '\'"></span>' +
          '<span class="si-main" data-act="queue-play" data-index="' + i + '"><span class="si-name">' + esc(s.name || '') + '</span>' +
            '<span class="si-sub">' + esc(s.singer || '') + '</span></span>' +
          '<button class="si-del" type="button" data-act="queue-remove" data-index="' + i + '">' + ico('i-close') + '</button>' +
        '</div>'
    }).join('')
    sheetOpen('播放队列（' + st.queue.length + '）', '<div class="sheet-list">' + rows + '</div>')
  }

  /* 音质不再是独立弹层：统一跳进合并面板的「音质」tab */
  function updateQualitySheet() {
    soundOpen('quality')
  }

  /* ===========================================================
     音效面板（对齐 QQ音乐 音效页）
     -----------------------------------------------------------
     纯 UI 控制层：所有音频处理在 js/audiofx.js（Web Audio 链），
     这里只负责渲染、交互与状态同步，不直接操作音频节点。
     =========================================================== */
  var FX_RATES = [0.75, 1, 1.25, 1.5, 2]
  var fxBound = false

  function realLabel(q) {
    return ({
      '128k': '标准 128K',
      '320k': '较高 320K',
      flac: '无损 FLAC',
      flac24bit: 'Hi-Res 24Bit',
      auto: '自动',
      lossless: '严格无损',
    })[q] || (q || '未知')
  }

  function fxState() {
    return (window.AudioFX && AudioFX.state) ? AudioFX.state() : null
  }

  function fxPresetName(key) {
    if (!window.AudioFX) return '原声'
    var p = AudioFX.PRESETS[key]
    if (p) return p.name
    var c = AudioFX.state().customPresets[key]
    return c ? c.name : '原声'
  }

  /* ===========================================================
     音质 + 音效 合并面板
     —— 播放页底栏只有一个入口「音质音效」，面板内分「音质」「音效」两个 tab
     —— 面板 position:fixed 全屏独立层，只有 .sp-scroll 内部滚动
     =========================================================== */
  var soundTab = 'quality'
  var Q_ITEMS = [
    { k: 'auto', t: '自动', d: '逐档尝试，能上无损就上无损', tag: '' },
    { k: 'lossless', t: '严格无损', d: '只接受实测真无损，宁缺毋滥', tag: '最严谨' },
    { k: '128k', t: '标准', d: 'MP3 128K · 省流量', tag: '' },
    { k: '320k', t: '较高', d: 'MP3 320K · 推荐', tag: '默认' },
    { k: 'flac', t: '无损', d: 'FLAC · 实测 16bit 起', tag: '' },
    { k: 'flac24bit', t: 'Hi-Res', d: '标称 24bit，实测不达标会标真值', tag: '' },
  ]

  function qShort(q) {
    return ({ auto: '自动', lossless: '严格无损', '128k': '标准', '320k': '较高', flac: '无损', flac24bit: 'Hi-Res' })[q] || (q || '较高')
  }

  function soundOpen(tab) {
    var el = $('#soundPanel')
    if (!el) return
    el.classList.add('open')
    el.setAttribute('aria-hidden', 'false')
    document.body.classList.add('panel-open')
    if (!fxBound) fxBindInputs()
    soundTab = tab === 'fx' ? 'fx' : 'quality'
    soundSyncTabs()
    fxRenderAll()
    renderQualityPane()
    renderDiag()
    dgStart()
    /* 打开面板本身是用户手势：顺便唤醒可能挂起的 AudioContext */
    if (window.AudioFX && AudioFX.resume) AudioFX.resume()
  }

  function soundClose() {
    var el = $('#soundPanel')
    if (!el) return
    el.classList.remove('open')
    el.setAttribute('aria-hidden', 'true')
    if (!$('#detailPanel').classList.contains('open') &&
        !$('#searchPanel').classList.contains('open') &&
        !$('#importPanel').classList.contains('open')) {
      document.body.classList.remove('panel-open')
    }
    renderSoundBadges()
    dgStop()
  }

  function soundSyncTabs() {
    var el = $('#soundPanel')
    if (!el) return
    $$('.sp-tab', el).forEach(function (b) {
      var on = b.getAttribute('data-tab') === soundTab
      b.classList.toggle('on', on)
      b.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    var pq = $('#paneQuality')
    var pf = $('#paneFx')
    if (pq) pq.hidden = soundTab !== 'quality'
    if (pf) pf.hidden = soundTab !== 'fx'
    var sc = $('#spScroll')
    if (sc) sc.scrollTop = 0
  }

  function soundSwitchTab(tab) {
    soundTab = tab === 'fx' ? 'fx' : 'quality'
    soundSyncTabs()
    if (soundTab === 'fx') {
      dgStop()
      fxRenderAll()
    } else {
      renderQualityPane()
      renderDiag()
      dgStart()
    }
  }

  /* 实测编码一行摘要：codec + 位深/采样率 + 大小 + 音源 */
  var LOSSLESS_REAL = { flac: 1, flac24bit: 1 }
  var CODEC_OF = { flac24bit: 'FLAC 24bit', flac: 'FLAC', '320k': 'MP3', '128k': 'MP3' }

  function realCodec(real, info) {
    if (info && info.codec) return String(info.codec).toUpperCase()
    return CODEC_OF[real] || ''
  }

  function realInfoLine(info, real) {
    if (!info) return ''
    var parts = []
    var codec = realCodec(real, info)
    if (codec) parts.push(codec)
    if (info.bitsPerSample && info.sampleRate) {
      parts.push(info.bitsPerSample + 'bit/' + (info.sampleRate / 1000).toFixed(1) + 'kHz')
    } else if (info.detail) {
      parts.push(info.detail)
    }
    if (info.sizeText) parts.push(info.sizeText)
    if (info.api) parts.push('音源 ' + info.api)
    return parts.join(' · ')
  }

  function renderQualityPane() {
    var st = Player.state
    var list = $('#qList')
    if (!list) return

    /* 档位列表 */
    list.innerHTML = Q_ITEMS.map(function (it) {
      var on = st.quality === it.k
      return '<button class="q-row' + (on ? ' on' : '') + '" type="button" data-act="q-pick" data-q="' + it.k + '">' +
        '<span class="q-main"><b>' + esc(it.t) + '</b><i>' + esc(it.d) + '</i></span>' +
        (it.tag ? '<span class="q-tag">' + esc(it.tag) + '</span>' : '') +
        '<span class="q-radio"></span>' +
      '</button>'
    }).join('')

    /* 严格无损开关：等价于选中 lossless 档 */
    var sw = $('#qStrict')
    if (sw) sw.setAttribute('aria-pressed', st.quality === 'lossless' ? 'true' : 'false')

    /* 当前音频流实测结果 */
    var info = st.realInfo
    var title = $('#qRealTitle')
    var sub = $('#qRealSub')
    var badge = $('#qRealBadge')
    var song = Player.current
    if (!song) {
      if (title) title.textContent = '尚未播放'
      if (sub) sub.textContent = '开始播放后这里显示当前音频流的实测编码'
      if (badge) badge.hidden = true
      return
    }
    var real = st.realQuality || ''
    var isLossless = !!LOSSLESS_REAL[real]
    /* 标称 Hi-Res 却只拿到 16bit FLAC：请求档位与实际编码不一致 */
    var fakeHiRes = !!(info && (info.fakeHiRes || (info.requested === 'flac24bit' && real === 'flac')))

    if (title) title.textContent = real ? (realLabel(real) || String(real).toUpperCase()) : '解析中…'
    if (sub) {
      var line = realInfoLine(info, real)
      sub.textContent = line || '已请求 ' + qShort(st.quality) + '，正在解析可用音源'
    }
    if (badge) {
      if (fakeHiRes) {
        badge.hidden = false
        badge.className = 'q-badge warn'
        badge.textContent = '标称24bit·实测16bit'
      } else if (isLossless) {
        badge.hidden = false
        badge.className = 'q-badge ok'
        badge.textContent = '真无损'
      } else if (real) {
        badge.hidden = false
        badge.className = 'q-badge'
        badge.textContent = '有损'
      } else {
        badge.hidden = true
      }
    }
  }

  /* ---------------- 音质诊断面板（实时） ---------------- */
  var dgTimer = 0
  var dgRun = false
  var dgBands = []

  function dgActive() {
    var p = $('#soundPanel')
    if (!p || !p.classList.contains('open')) return false
    return soundTab === 'quality'
  }

  function dgSet(sel, txt) {
    var el = $(sel)
    if (el) el.textContent = txt
  }

  function dgBar(sel, db) {
    var el = $(sel)
    if (!el) return
    /* -60dB~0dB 映射到 0~100% */
    var pct = !isFinite(db) ? 0 : Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
    el.style.width = pct.toFixed(1) + '%'
  }

  function dgDrawSpec() {
    var cv = $('#dgSpec')
    if (!cv) return
    var dpr = Math.min(window.devicePixelRatio || 1, 3)
    var w = cv.clientWidth || 320
    var h = cv.clientHeight || 60
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
    }
    var g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)

    var n = dgBands.length
    if (!n) return
    var bw = w / n
    for (var i = 0; i < n; i++) {
      var v = Math.max(0, Math.min(1, dgBands[i]))
      var bh = v * (h - 2)
      if (bh < 0.6) continue
      var grad = g.createLinearGradient(0, h, 0, h - bh)
      grad.addColorStop(0, 'rgba(49,194,124,.85)')
      grad.addColorStop(1, 'rgba(49,194,124,.32)')
      g.fillStyle = grad
      g.fillRect(i * bw + 0.4, h - bh, Math.max(1, bw - 0.8), bh)
    }
  }

  /* 诊断面板渲染一帧：编码信息来自服务端 probe，响度/峰值/频谱来自 Web Audio 探针 */
  function renderDiag() {
    var card = $('#dgCard')
    if (!card) return
    var song = Player.current
    var info = Player.state.realInfo || null
    var d = (window.AudioFX && AudioFX.diag) ? AudioFX.diag() : null
    var stream = (d && d.stream) || {}
    var live = !!(d && d.ready)

    /* 编码 / 位深 / 采样率 / 声道：优先实测流信息，其次回落到服务端探测结果 */
    var codec = stream.codec || (info && info.codec) || ''
    var bits = stream.bitsPerSample || (info && info.bitsPerSample) || 0
    var sr = stream.sampleRate || (info && info.sampleRate) || 0
    var ch = stream.channels || (info && info.channels) || 0

    dgSet('#dgCodec', codec ? String(codec).toUpperCase() : (song ? '解析中…' : '--'))
    dgSet('#dgBits', bits ? bits + 'bit' : '--')
    dgSet('#dgSamplerate', sr ? (sr / 1000).toFixed(1) + 'kHz' : '--')
    dgSet('#dgChannels', ch ? (ch === 1 ? '单声道' : '立体声') : '--')

    if (!song) {
      dgSet('#dgState', '未播放')
      ;['#dgM', '#dgS', '#dgI', '#dgPeak'].forEach(function (s) { dgSet(s, '--') })
      dgSet('#dgClip', '削波 0 次')
      dgSet('#dgCorr', '相关度 --')
      dgSet('#dgGain', '补偿 --')
      dgBar('#dgBarL', -Infinity)
      dgBar('#dgBarR', -Infinity)
      dgBands = []
      dgDrawSpec()
      return
    }

    if (!live) {
      dgSet('#dgState', d && d.ctx && d.ctx !== 'none' ? ('音频上下文 ' + d.ctx) : '未开启音效')
      ;['#dgM', '#dgS', '#dgI', '#dgPeak'].forEach(function (s) { dgSet(s, '--') })
      dgSet('#dgClip', '削波 0 次')
      dgSet('#dgCorr', '相关度 --')
      dgSet('#dgGain', '补偿 --')
      dgBar('#dgBarL', -Infinity)
      dgBar('#dgBarR', -Infinity)
      dgBands = []
      dgDrawSpec()
      /* 未建链时给一次性入口：点击后在用户手势内建链（保持原声直通，不启用任何音效） */
      var be = $('#dgEnable')
      if (be) be.hidden = !(Player.current && !(d && d.ctx && d.ctx !== 'none'))
      return
    }
    var beOn = $('#dgEnable')
    if (beOn) beOn.hidden = true

    dgSet('#dgState', d.bypassed ? '原声直通 · 实时测量' : '音效链 · 实时测量')

    var loud = d.loud || {}
    var mom = loud.m
    var sho = loud.s
    var intg = loud.i
    dgSet('#dgM', isFinite(mom) ? mom.toFixed(1) + ' LUFS' : '--')
    dgSet('#dgS', isFinite(sho) ? sho.toFixed(1) + ' LUFS' : '--')
    dgSet('#dgI', isFinite(intg) ? intg.toFixed(1) + ' LUFS' : '--')

    var pk = d.peak || {}
    dgSet('#dgPeak', isFinite(pk.db) ? pk.db.toFixed(1) + ' dBFS' : '--')
    dgSet('#dgClip', '削波 ' + (pk.clip || 0) + ' 次')

    var corr = d.corr
    dgSet('#dgCorr', isFinite(corr) ? '相关度 ' + corr.toFixed(2) + (corr < 0 ? ' (反相)' : '') : '相关度 --')

    var gd = loud.gainDb
    dgSet('#dgGain', (loud.on && isFinite(gd)) ? ('补偿 ' + (gd > 0 ? '+' : '') + gd.toFixed(1) + 'dB') : '补偿 --')

    var lv = d.level || {}
    dgBar('#dgBarL', lv.l)
    dgBar('#dgBarR', lv.r)

    dgBands = AudioFX.spectrum(40)
    dgDrawSpec()
  }

  function dgLoop() {
    dgTimer = 0
    if (!dgRun || !dgActive()) { dgRun = false; return }
    try { renderDiag() } catch (e) { /* 面板异常不影响播放 */ }
    if (!dgRun) return
    /* 10fps 刷新足够，降低 WebView 功耗 */
    dgTimer = setTimeout(dgLoop, 100)
  }

  function dgStart() {
    if (!dgActive()) return
    if (dgRun && dgTimer) return
    dgRun = true
    if (dgTimer) { clearTimeout(dgTimer); dgTimer = 0 }
    dgLoop()
  }

  /* 一键开启实时测量：仅建链并保持原声直通，不更改音效开关与任何参数 */
  function dgEnableLive() {
    try {
      if (Player.enableDiag) Player.enableDiag()
      else if (Player.audio && window.AudioFX) AudioFX.attach(Player.audio, true)
      if (window.AudioFX && AudioFX.resume) AudioFX.resume()
    } catch (e) { console.warn('[diag] 建链失败', e) }
    var be = $('#dgEnable')
    if (be) be.hidden = true
    renderDiag()
    dgStart()
  }

  function dgStop() {
    dgRun = false
    if (dgTimer) { clearTimeout(dgTimer); dgTimer = 0 }
  }

  /* 播放页底栏「音质音效」两行标签 + 音效开关态 */
  function renderSoundBadges() {
    var st = Player.state
    var ql = $('#qualityLabel')
    if (ql) ql.textContent = qShort(st.realQuality || st.quality)
    var lab = $('#fxLabel')
    var fs = fxState()
    if (lab) {
      lab.textContent = fs && fs.enabled ? fxPresetName(fs.preset) : '音质音效'
    }
    var btn = $('#btnSound')
    if (btn) btn.classList.toggle('on', !!(fs && fs.enabled))
  }

  /* 播放模式：列表循环 / 单曲循环 / 随机 */
  var MODE_META = {
    order: { icon: 'i-order', label: '列表循环' },
    single: { icon: 'i-single', label: '单曲循环' },
    shuffle: { icon: 'i-shuffle', label: '随机播放' },
  }

  /* v45：按模式取图标，容错 MODE_META 尚未初始化（早期渲染）的情况 */
  function modeIcon(mode) {
    var meta = typeof MODE_META === 'object' && MODE_META ? MODE_META : null
    var m = (meta && (meta[mode] || meta.order)) || { icon: 'i-order' }
    return m.icon
  }

  function renderPlayMode() {
    var mode = Player.playMode || 'order'
    var meta = MODE_META[mode] || MODE_META.order
    var btn = $('#btnMode')
    if (btn) {
      setBtnIcon(btn, meta.icon)
      btn.setAttribute('aria-label', meta.label)
      btn.classList.toggle('on', mode !== 'order')
    }
    var cell = $('#cellPlayMode')
    if (cell) cell.textContent = meta.label
    /* v45：刷歌页侧键与播放页按钮是同一个模式开关，必须同步换图标，
       否则在刷歌页点了永远显示列表循环图标 */
    var swBtns = document.querySelectorAll('.page[data-page="swipe"] .swipe-ctrl .sctrl[data-act="mode-cycle"]')
    for (var mi = 0; mi < swBtns.length; mi++) {
      var sb = swBtns[mi]
      setBtnIcon(sb, meta.icon)
      sb.setAttribute('aria-label', meta.label)
      sb.classList.toggle('on', mode !== 'order')
    }
  }

  /* 定时关闭 */
  var sleepTimer = null
  var sleepEndAt = 0

  function sleepClear() {
    if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null }
    sleepEndAt = 0
    var b = $('#btnSleep')
    if (b) b.classList.remove('on')
    var l = $('#sleepLabel')
    if (l) { l.hidden = true; l.textContent = '' }
  }

  function sleepSet(minutes) {
    sleepClear()
    if (!minutes) { toast('已取消定时关闭'); return }
    var ms = minutes * 60000
    sleepEndAt = Date.now() + ms
    sleepTimer = setTimeout(function () {
      try { if (Player.state.playing) Player.toggle() } catch (e) {}
      sleepClear()
      toast('定时关闭已生效，已暂停播放')
    }, ms)
    var b = $('#btnSleep')
    if (b) b.classList.add('on')
    var l = $('#sleepLabel')
    if (l) { l.hidden = false; l.textContent = minutes + '分' }
    toast(minutes + ' 分钟后停止播放')
  }

  function openSleepSheet() {
    var opts = [15, 30, 60, 90]
    var html = '<div class="chips">' + opts.map(function (m) {
      return '<button class="chip' + (sleepEndAt ? '' : '') + '" type="button" data-act="sleep-set" data-min="' + m + '">' + m + ' 分钟</button>'
    }).join('') + '</div>' +
      '<div class="chips" style="margin-top:10px">' +
        '<button class="chip" type="button" data-act="sleep-end-of-song">播完本曲停止</button>' +
        '<button class="chip" type="button" data-act="sleep-set" data-min="0">关闭定时</button>' +
      '</div>' +
      (sleepEndAt ? '<div class="muted" style="margin-top:12px">当前定时：约 ' + Math.max(1, Math.round((sleepEndAt - Date.now()) / 60000)) + ' 分钟后停止</div>' : '')
    sheetOpen('定时关闭', html)
  }

  /* 更多：把当前曲目可用的功能集中，同时标注平台侧限制（不编造已实现） */
  function openMoreSheet() {
    var song = Player.current
    if (!song) { toast('还没有选择歌曲'); return }
    var st = Player.state
    var html = '<div class="muted" style="margin-bottom:6px">' + esc(song.name || '') + ' - ' + esc(song.singer || '') + '</div>' +
      '<div class="chips">' +
        '<button class="chip" type="button" data-act="open-queue">播放队列</button>' +
        '<button class="chip" type="button" data-act="open-addto">收藏到歌单</button>' +
        '<button class="chip" type="button" data-act="open-sleep">定时关闭</button>' +
        '<button class="chip" type="button" data-act="download-current">下载</button>' +
        '<button class="chip" type="button" data-act="open-sound" data-tab="quality">音质与音效</button>' +
      '</div>' +
      '<div class="sheet-sec">曲目信息</div>' +
      '<div class="more-info">' +
        '<div class="more-info-row"><span class="k">专辑</span><span class="v">' + esc(song.albumName || '—') + '</span></div>' +
        '<div class="more-info-row"><span class="k">音源</span><span class="v">' + esc(String(song.source || 'kw').toUpperCase()) + '</span></div>' +
        '<div class="more-info-row"><span class="k">实测音质</span><span class="v">' + esc(realLabel(st.realQuality || st.quality)) + (realInfoLine(st.realInfo) ? '（' + esc(realInfoLine(st.realInfo)) + '）' : '') + '</span></div>' +
      '</div>'
    sheetOpen('更多', html)
  }

  /* 历史命名保留：音效状态变化时刷新底栏「音质音效」入口的两行标签 */
  function fxSyncBadge() {
    renderSoundBadges()
  }

  function fxRenderAll() {
    var st = fxState()
    if (!st) return
    var sw = $('#fxSwitch')
    if (sw) sw.setAttribute('aria-pressed', st.enabled ? 'true' : 'false')
    var stateTxt = $('#fxStateText')
    if (stateTxt) stateTxt.textContent = st.enabled ? ('已开启 · ' + fxPresetName(st.preset)) : '关闭时为原声直通'

    fxRenderPresets()
    fxRenderEq()
    fxRenderRate()

    var wr = $('#fxWidth')
    if (wr) wr.value = Math.round((st.width || 0) * 100)
    var wv = $('#fxWidthVal')
    if (wv) wv.textContent = Math.round((st.width || 0) * 100) + '%'
    var br = $('#fxBass')
    if (br) br.value = Math.round((st.bass || 0) * 100)
    var bv = $('#fxBassVal')
    if (bv) bv.textContent = Math.round((st.bass || 0) * 100) + '%'
    var ex = $('#fxExciter')
    if (ex) ex.value = Math.round((st.exciter || 0) * 100)
    var exv = $('#fxExciterVal')
    if (exv) exv.textContent = Math.round((st.exciter || 0) * 100) + '%'
    fxRenderAmb()
    fxRenderR128()
    var fr = $('#fxFade')
    if (fr) fr.value = st.fade || 0
    var fv = $('#fxFadeVal')
    if (fv) fv.textContent = (st.fade || 0).toFixed(1) + 's'

    fxDrawCurve()
    fxSyncBadge()
  }

  function fxRenderPresets() {
    var box = $('#fxPresets')
    if (!box || !window.AudioFX) return
    var st = fxState()
    var html = Object.keys(AudioFX.PRESETS).map(function (k) {
      var on = st.preset === k
      return '<button class="fx-chip' + (on ? ' on' : '') + '" type="button" data-act="fx-preset" data-id="' + esc(k) + '">' +
        esc(AudioFX.PRESETS[k].name) + '</button>'
    }).join('')
    box.innerHTML = html

    /* 自定义预设：点选生效，长按 700ms 删除 */
    var cbox = $('#fxCustom')
    if (!cbox) return
    var keys = Object.keys(st.customPresets || {})
    if (!keys.length) {
      cbox.innerHTML = '<span class="fx-empty">还没有自定义预设，调好后点上方按钮保存</span>'
      return
    }
    cbox.innerHTML = keys.map(function (k) {
      var on = st.preset === k
      return '<button class="fx-chip' + (on ? ' on' : '') + '" type="button" data-act="fx-preset" data-id="' + esc(k) + '">' +
        esc(st.customPresets[k].name || k) + '</button>'
    }).join('')
    Array.prototype.forEach.call(cbox.children, function (btn) {
      var t = 0
      var start = function () {
        t = setTimeout(function () {
          t = 0
          fxDelCustom(btn.getAttribute('data-id'))
        }, 700)
      }
      var cancel = function () { if (t) { clearTimeout(t); t = 0 } }
      btn.addEventListener('touchstart', start, { passive: true })
      btn.addEventListener('touchend', cancel)
      btn.addEventListener('touchmove', cancel)
      btn.addEventListener('mousedown', start)
      btn.addEventListener('mouseup', cancel)
      btn.addEventListener('mouseleave', cancel)
    })
  }

  /* 空间感模式 chips：ir=卷积 IR（默认），delay=旧版假环绕（可选） */
  function fxRenderAmb() {
    var box = $('#fxAmb')
    if (!box || !window.AudioFX) return
    var st = fxState()
    var modes = AudioFX.AMB_MODES || []
    var cur = st.ambienceMode || 'ir'
    box.innerHTML = modes.map(function (m) {
      return '<button class="fx-chip' + (m.k === cur ? ' on' : '') + '" type="button" data-act="fx-amb" data-mode="' + esc(m.k) + '">' +
        esc(m.name) + '</button>'
    }).join('')
    var lab = $('#fxAmbVal')
    if (lab) {
      var hit = null
      for (var i = 0; i < modes.length; i++) if (modes[i].k === cur) hit = modes[i]
      lab.textContent = hit ? hit.name : '卷积 IR'
    }
  }

  /* EBU R128 响度标准化开关 + 目标响度 chips */
  function fxRenderR128() {
    var st = fxState()
    if (!st) return
    var sw = $('#fxR128')
    if (sw) sw.setAttribute('aria-pressed', st.r128 ? 'true' : 'false')
    var tgt = Number(st.r128Target || -14)
    var lab = $('#fxR128TargetVal')
    if (lab) lab.textContent = tgt + ' LUFS'
    var box = $('#fxR128Target')
    if (box && window.AudioFX) {
      var list = AudioFX.R128_TARGETS || [-14]
      box.innerHTML = list.map(function (v) {
        return '<button class="fx-chip' + (Math.abs(tgt - v) < 0.01 ? ' on' : '') + '" type="button" data-act="fx-r128-target" data-lufs="' + v + '">' +
          v + ' LUFS</button>'
      }).join('')
    }
    var note = $('#fxR128Text')
    if (note) {
      note.textContent = st.r128
        ? ('已启用：按短时响度动态补偿到 ' + tgt + ' LUFS，超峰自动让路')
        : '按真实短时/积分响度动态补偿，切歌不再忽大忽小'
    }
  }

  function fxRenderRate() {
    var box = $('#fxRate')
    if (!box) return
    var st = fxState()
    box.innerHTML = FX_RATES.map(function (r) {
      var on = Math.abs((st.rate || 1) - r) < 0.01
      return '<button class="fx-chip' + (on ? ' on' : '') + '" type="button" data-act="fx-rate" data-rate="' + r + '">' + r.toFixed(2).replace(/0$/, '') + 'x</button>'
    }).join('')
    var rv = $('#fxRateVal')
    if (rv) rv.textContent = (st.rate || 1).toFixed(1) + 'x'
  }

  function fxRenderEq() {
    var box = $('#fxEq')
    if (!box || !window.AudioFX) return
    var st = fxState()
    box.innerHTML = AudioFX.BANDS.map(function (f, i) {
      var g = st.eq[i] || 0
      return '<div class="fx-eq-item">' +
          '<span class="fx-eq-val" id="fxEqVal' + i + '">' + (g > 0 ? '+' : '') + g.toFixed(0) + '</span>' +
          '<input type="range" min="-12" max="12" step="1" value="' + g + '" data-band="' + i + '" aria-label="' + AudioFX.BAND_LABEL[i] + 'Hz">' +
          '<span class="fx-eq-lab">' + AudioFX.BAND_LABEL[i] + '</span>' +
        '</div>'
    }).join('')
    /* 原声/未启用时给出直观提示 */
    var now = st.eq.every(function (v) { return v === 0 })
    var lab = $('#fxEqNow')
    if (lab) lab.textContent = now ? '全平 0dB' : '自定义曲线'
  }

  /* EQ 曲线：音效链已建时读真实节点响应；未建链时按频段增益做对数域拟合，保证调节可见 */
  function fxCurveData(st) {
    var pts = 96
    if (window.AudioFX && AudioFX.isReady && AudioFX.isReady()) {
      var real = AudioFX.curve(pts)
      return { freqs: real.freqs, db: real.db, real: true }
    }
    var freqs = []
    var db = []
    var bands = AudioFX.BANDS
    for (var i = 0; i < pts; i++) {
      var f = 20 * Math.pow(1000, i / (pts - 1))
      freqs.push(f)
      var sum = 0
      for (var b = 0; b < bands.length; b++) {
        var g = st.enabled ? (st.eq[b] || 0) : 0
        if (!g) continue
        var d = Math.log(f / bands[b]) / Math.LN2
        sum += g * Math.exp(-(d * d) / 0.42)
      }
      db.push(sum)
    }
    return { freqs: freqs, db: db, real: false }
  }

  function fxDrawCurve() {
    var cv = $('#fxCurve')
    if (!cv || !window.AudioFX) return
    var st = fxState()
    var dpr = Math.min(window.devicePixelRatio || 1, 3)
    var w = cv.clientWidth || 320
    var h = 74
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
    }
    var g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)

    var data = fxCurveData(st)
    var yOf = function (db) {
      db = Math.max(-13, Math.min(13, db))
      return h / 2 - (db / 13) * (h / 2 - 8)
    }
    var xOf = function (f) {
      return (Math.log(f / 20) / Math.log(1000)) * w
    }

    /* 网格：±12dB / 0dB 基准线 */
    g.strokeStyle = 'rgba(0,0,0,.06)'
    g.lineWidth = 1
    ;[-12, -6, 0, 6, 12].forEach(function (db) {
      var y = yOf(db)
      g.beginPath()
      g.moveTo(0, y)
      g.lineTo(w, y)
      if (db === 0) { g.strokeStyle = 'rgba(0,0,0,.16)'; g.stroke(); g.strokeStyle = 'rgba(0,0,0,.06)' } else g.stroke()
    })

    /* 曲线 + 渐变填充 */
    g.beginPath()
    for (var i = 0; i < data.db.length; i++) {
      var x = xOf(data.freqs[i])
      var y = yOf(data.db[i])
      if (i === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.lineWidth = 2
    g.strokeStyle = '#31c27c'
    g.stroke()

    g.lineTo(w, yOf(-13))
    g.lineTo(0, yOf(-13))
    g.closePath()
    var grad = g.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, 'rgba(49,194,124,.22)')
    grad.addColorStop(1, 'rgba(49,194,124,0)')
    g.fillStyle = grad
    g.fill()
  }

  /* 滑杆输入绑定（只绑一次） */
  function fxBindInputs() {
    fxBound = true
    var eq = $('#fxEq')
    if (eq) {
      eq.addEventListener('input', function (e) {
        var t = e.target
        if (!t || t.type !== 'range' || !t.getAttribute('data-band')) return
        var i = Number(t.getAttribute('data-band'))
        var v = Number(t.value)
        AudioFX.setEqBand(i, v)
        var lab = $('#fxEqVal' + i)
        if (lab) lab.textContent = (v > 0 ? '+' : '') + v
        var now = $('#fxEqNow')
        if (now) now.textContent = '自定义曲线'
        fxDrawCurve()
        fxSyncBadge()
      })
      eq.addEventListener('change', function () {
        /* 手感优化：手指抬起后再刷新整块（预设高亮变为"自定义"） */
        fxRenderPresets()
      })
    }
    var wr = $('#fxWidth')
    if (wr) wr.addEventListener('input', function () {
      var v = Number(wr.value) / 100
      AudioFX.setWidth(v)
      var el = $('#fxWidthVal')
      if (el) el.textContent = Math.round(v * 100) + '%'
    })
    var br = $('#fxBass')
    if (br) br.addEventListener('input', function () {
      var v = Number(br.value) / 100
      AudioFX.setBass(v)
      var el = $('#fxBassVal')
      if (el) el.textContent = Math.round(v * 100) + '%'
    })
    var ex = $('#fxExciter')
    if (ex) ex.addEventListener('input', function () {
      var v = Number(ex.value) / 100
      AudioFX.setExciter(v)
      var el = $('#fxExciterVal')
      if (el) el.textContent = Math.round(v * 100) + '%'
    })
    var fr = $('#fxFade')
    if (fr) fr.addEventListener('input', function () {
      var v = Number(fr.value)
      AudioFX.setFade(v)
      var el = $('#fxFadeVal')
      if (el) el.textContent = v.toFixed(1) + 's'
    })
    window.addEventListener('resize', function () {
      if ($('#soundPanel') && $('#soundPanel').classList.contains('open')) fxDrawCurve()
    })
  }

  function fxToggle() {
    var st = fxState()
    if (!st) return
    var on = AudioFX.setEnabled(!st.enabled)
    toast(on ? ('音效已开启：' + fxPresetName(AudioFX.state().preset)) : '音效已关闭（原声直通）')
    fxRenderAll()
  }

  function fxToggleR128() {
    var st = fxState()
    if (!st) return
    var on = AudioFX.setR128(!st.r128)
    fxRenderAll()
    toast(on ? ('已开启 EBU R128 响度标准化（目标 ' + (st.r128Target || -14) + ' LUFS）') : '已关闭响度标准化，恢复直通增益')
  }

  /* 历史命名保留：旧「智能音量平衡」入口统一走 R128 */
  function fxToggleSmart() {
    fxToggleR128()
  }

  function fxPickAmb(mode) {
    if (!mode) return
    var st = fxState()
    if (st.ambienceMode === mode) return
    if (!AudioFX.setAmbienceMode(mode)) return
    fxRenderAll()
    toast('空间感：' + (mode === 'delay' ? '经典延迟（假环绕）' : '卷积 IR'))
  }

  function fxPickR128Target(lufs) {
    var v = Number(lufs)
    if (!isFinite(v)) return
    AudioFX.setR128Target(v)
    fxRenderAll()
    toast('目标响度 ' + v + ' LUFS')
  }

  function fxPickPreset(key) {
    if (!key) return
    if (!AudioFX.setPreset(key)) { toast('预设不存在'); return }
    fxRenderAll()
    toast('音效预设：' + fxPresetName(key))
  }

  function fxPickRate(r) {
    AudioFX.setRate(Number(r))
    fxRenderRate()
    fxSyncBadge()
    toast('播放速度 ' + Number(r).toFixed(2).replace(/0$/, '') + 'x')
  }

  function fxEqFlat() {
    AudioFX.setEqAll([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    fxRenderAll()
    toast('均衡器已全部归零')
  }

  function fxEqResetPreset() {
    var st = fxState()
    var p = AudioFX.PRESETS[st.preset] || AudioFX.state().customPresets[st.preset]
    if (!p || !p.eq) { fxEqFlat(); return }
    AudioFX.setEqAll(p.eq)
    AudioFX.setBass(p.bass || 0)
    AudioFX.setWidth(p.width || 0)
    fxRenderAll()
    toast('已恢复「' + fxPresetName(st.preset) + '」预设曲线')
  }

  function fxSaveCustom() {
    dialogOpen({
      title: '保存音效预设',
      placeholder: '给这套音效起个名字',
      hint: '保存当前均衡器、低音与立体声宽度；同名会覆盖',
      onOk: function (v) {
        if (!v || !String(v).trim()) { toast('请输入预设名称'); return false }
        AudioFX.savePreset(String(v).trim())
        fxRenderAll()
        toast('已保存预设：' + String(v).trim())
      },
    })
  }

  function fxDelCustom(key) {
    if (!key) return
    var st = fxState()
    if (!st.customPresets[key]) return
    AudioFX.removePreset(key)
    if (st.preset === key) { AudioFX.setPreset('original') }
    fxRenderAll()
    toast('已删除预设：' + key)
  }

  function fxResetAll() {
    if (!window.AudioFX) return
    AudioFX.setEqAll([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    AudioFX.setWidth(0)
    AudioFX.setBass(0)
    AudioFX.setExciter(0)
    AudioFX.setAmbienceMode('ir')
    AudioFX.setR128(false)
    AudioFX.setFade(0)
    AudioFX.setRate(1)
    AudioFX.setPreset('original')
    fxRenderAll()
    toast('音效设置已重置为原声')
  }

  function updateAddToSheet() {
    var song = Player.current
    if (!song) { toast('请先选择歌曲'); return }
    var rows = lib.playlists.map(function (p) {
      return '<button class="sheet-item" type="button" data-act="addto-playlist" data-id="' + esc(p.id) + '">' +
          ico('i-list') + '<span class="si-main"><span class="si-name">' + esc(p.name) + '</span>' +
          '<span class="si-sub">' + (p.songs ? p.songs.length : 0) + ' 首</span></span></button>'
    }).join('')
    sheetOpen('收藏到歌单',
      (rows || '<div class="muted" style="padding:6px 0">还没有歌单</div>') +
      '<button class="btn primary" type="button" data-act="open-newlist" style="margin-top:12px">' + ico('i-plus') + '新建歌单</button>')
  }

  /* ---------------- 迷你弹层：音源状态 ---------------- */
  function updateSourcesSheet() {
    sheetOpen('音源状态', '<div class="loading"><span class="spin"></span><span>正在读取…</span></div>')
    API.health().then(function (res) {
      var list = (res.sources || []).slice(0, 12).map(function (s) {
        return '<div class="sheet-item"><span class="si-main"><span class="si-name">' + esc(s.name) + '</span>' +
          '<span class="si-sub">' + esc(s.fileName || '') + '</span></span></div>'
      }).join('')
      var caps = res.capabilities || {}
      var capText = Object.keys(caps).map(function (k) {
        return k + ':' + ((caps[k].sources || []).length)
      }).join(' · ')
      sheetOpen('音源状态',
        '<div class="muted" style="margin-bottom:8px">已加载 ' + (res.sources || []).length + ' 个音源 · ' + esc(capText) + '</div>' +
        '<div class="sheet-list">' + list + '</div>')
    }).catch(function (e) {
      sheetOpen('音源状态', '<div class="errstate"><div class="err-title">读取失败</div><div class="err-sub">' + esc(e.message) + '</div></div>')
    })
  }

  /* ---------------- 外部歌单导入（QQ音乐 / 网易云 / 酷狗 / 纯文本兜底） ---------------- */
  var PLATFORM_TEXT = { qq: 'QQ音乐', wy: '网易云音乐', kg: '酷狗音乐', text: '纯文本歌单' }
  var importState = { step: 'idle', preview: null, saved: null, err: '', queue: [] }

  function importOpen() {
    openPanel('import')
    importRender()
  }

  function importReset() {
    importState.step = 'idle'
    importState.preview = null
    importState.saved = null
    importState.err = ''
    importState.queue = []
    var t = $('#importText')
    if (t) t.value = ''
    importRender()
  }

  function importBadge(platform) {
    var txt = PLATFORM_TEXT[platform] || '外部歌单'
    return '<span class="import-badge import-badge-' + esc(platform || 'x') + '">' + esc(txt) + '</span>'
  }

  function importCardHtml(opt) {
    var cover = opt.cover ? API.mediaUrl(opt.cover, API.coverPx(56, 200)) : DEFAULT_COVER
    return '' +
      '<div class="import-card">' +
        '<div class="imp-head">' +
          '<div class="ic-cover"><img src="' + esc(cover) + '" alt="" onerror="this.src=\'' + DEFAULT_COVER + '\'"></div>' +
          '<div class="ic-main">' +
            '<div class="ic-name">' + esc(opt.name || '未命名歌单') + importBadge(opt.platform) + '</div>' +
            '<div class="ic-sub">' + esc(opt.sub || '') + '</div>' +
          '</div>' +
        '</div>' +
        (opt.note ? '<div class="import-note">' + esc(opt.note) + '</div>' : '') +
        (opt.acts ? '<div class="import-acts">' + opt.acts + '</div>' : '') +
      '</div>'
  }

  function importListHtml(songs) {
    if (!songs || !songs.length) return ''
    return '<div class="sec-head"><div class="sec-title">曲目列表（' + songs.length + ' 首）</div></div>' +
      '<div class="import-list">' + songRows(songs) + '</div>'
  }

  function importRender() {
    var body = $('#importBody')
    if (!body) return
    var st = importState

    if (st.step === 'loading') {
      $('#importTitle').textContent = '正在导入'
      body.innerHTML = '<div class="loading"><span class="spin"></span><span>正在解析歌单，请稍候…</span></div>' +
        '<div class="import-note">QQ音乐 / 网易云 / 酷狗 歌单需要联网抓取，网络较慢时约需 5~15 秒</div>'
      return
    }

    if (st.step === 'error') {
      $('#importTitle').textContent = '导入歌单'
      body.innerHTML = '' +
        '<div class="errstate">' + ico('i-alert') +
          '<div class="err-title">导入失败</div>' +
          '<div class="err-sub">' + esc(st.err || '歌单解析失败，请稍后重试') + '</div>' +
          '<div class="import-fail"><b>可这样处理：</b><br>1) 确认歌单是公开歌单，并用浏览器打开能看到的链接；<br>2) 也可以直接把曲目整理成纯文本粘贴（每行一首，格式 <b>歌名 - 歌手</b>），无需链接。</div>' +
          '<button class="err-retry" type="button" data-act="import-retry">重新解析</button>' +
        '</div>'
      return
    }

    if (st.step === 'preview' && st.preview) {
      var p = st.preview
      var sub = [p.creator, (p.songTotal || 0) + ' 首可导入'].filter(Boolean).join(' · ')
      var note = p.truncated || ('仅保存曲目信息（序号 / 歌名 / 歌手 / 封面），不下载音频；播放时按「歌名 + 歌手」自动匹配音源')
      if (p.songCount && p.songTotal && p.songCount > p.songTotal) {
        note = note + '。该歌单共 ' + p.songCount + ' 首，本次解析到 ' + p.songTotal + ' 首'
      }
      $('#importTitle').textContent = '解析结果'
      body.innerHTML = importCardHtml({
        cover: p.cover, name: p.name || '导入歌单', platform: p.platform, sub: sub, note: note,
        acts: '<button class="btn primary" type="button" data-act="import-confirm">确认导入</button>' +
              '<button class="btn" type="button" data-act="import-cancel">取消</button>',
      }) + importListHtml(st.queue)
      return
    }

    if (st.step === 'done' && st.saved) {
      var sv = st.saved
      $('#importTitle').textContent = '导入完成'
      body.innerHTML = importCardHtml({
        cover: sv.cover, name: sv.name, platform: sv.platform,
        sub: '已保存到「我的歌单」· ' + sv.count + ' 首',
        note: '整单已就绪：点任意曲目即从该首开始连续播放，播放时自动匹配音源；个别曲目匹配不到会提示原因并自动跳下一首',
        acts: '<button class="btn primary" type="button" data-act="import-play" data-index="0">播放全部</button>' +
              '<button class="btn" type="button" data-act="import-open-list">打开歌单</button>',
      }) + importListHtml(st.queue) +
        '<div class="import-acts" style="margin-top:12px"><button class="btn" type="button" data-act="import-cancel">继续导入</button></div>'
      return
    }

    $('#importTitle').textContent = '导入歌单'
    body.innerHTML = '<div class="empty">支持 QQ音乐、网易云、酷狗 歌单链接 / 歌单 ID；解析失败时可粘贴纯文本歌单兜底（每行一首：歌名 - 歌手）</div>'
  }

  function importExtractText() {
    var t = $('#importText')
    return t ? String(t.value || '').trim() : ''
  }

  /* 第一步：解析预览（不入库，先让用户确认曲目） */
  function importSubmit() {
    var text = importExtractText()
    if (!text) { toast('请先粘贴歌单链接、歌单 ID 或纯文本歌单'); return }
    importState.step = 'loading'
    importState.err = ''
    importState.preview = null
    importState.saved = null
    importState.queue = []
    importRender()

    API.playlistImportPreview(text).then(function (res) {
      importState.preview = res
      importState.queue = (res.songs || []).map(function (s, i) {
        return {
          source: 'import',
          name: s.name || '',
          singer: s.singer || '',
          albumName: s.albumName || '',
          img: s.img || '',
          duration: s.duration || 0,
          interval: s.duration ? fmtTime(s.duration) : '',
          importPlatform: res.platform || '',
          importSeq: s.seq || (i + 1),
        }
      })
      if (!importState.queue.length) {
        importState.step = 'error'
        importState.err = '解析成功但歌单里没有取到任何歌曲，可能歌单为空或平台限制了访问'
        importRender()
        return
      }
      importState.step = 'preview'
      importRender()
    }).catch(function (e) {
      importState.step = 'error'
      importState.err = (e && e.message) || '歌单解析失败'
      importRender()
    })
  }

  /* 第二步：确认导入并落本地歌单 */
  function importConfirm() {
    var text = importExtractText()
    if (!text) { toast('请先粘贴歌单链接或歌单 ID'); return }
    importState.step = 'loading'
    importRender()

    API.playlistImport(text).then(function (res) {
      var pl = (res && res.playlist) || {}
      var songs = pl.songs || []
      if (!songs.length) throw new Error('导入完成但没有保存任何曲目，请重试')
      importState.saved = {
        id: pl.id,
        name: pl.name || (importState.preview && importState.preview.name) || '导入歌单',
        cover: pl.cover || (importState.preview && importState.preview.cover) || '',
        platform: pl.importPlatform || (importState.preview && importState.preview.platform) || '',
        count: songs.length,
      }
      importState.queue = songs
      importState.step = 'done'
      importRender()
      return loadLibrary()
    }).then(function () {
      renderMine()
      toast('歌单已导入「我的歌单」')
    }).catch(function (e) {
      importState.step = 'error'
      importState.err = (e && e.message) || '导入失败'
      importRender()
    })
  }

  /* ---------------- 事件 ---------------- */
  function songsOfPanel() {
    if ($('#importPanel').classList.contains('open')) return importState.queue
    if ($('#searchPanel').classList.contains('open')) return searchState.list
    return detailSongs
  }

  function bindActions() {
    document.addEventListener('click', function (ev) {
      var el = ev.target.closest ? ev.target.closest('[data-act]') : null
      if (!el) return
      var act = el.getAttribute('data-act')
      var idx = Number(el.getAttribute('data-index'))
      var listKey = el.getAttribute('data-list')
      var songs = listKey && blockSongs[listKey] ? blockSongs[listKey] : songsOfPanel()

      switch (act) {
        case 'play-index':
          if (!songs[idx]) return
          ev.stopPropagation()
          Player.playList(songs, idx)
          break
        case 'toggle-fav': {
          ev.stopPropagation()
          var list = songs
          var target = el.hasAttribute('data-index') && !isNaN(idx) ? list[idx] : Player.current
          if (!target) {
            /* 播放页/详情页按钮 */
            target = Player.current
          }
          toggleFav(target || songs[idx])
          break
        }
        case 'play-all':
          if (!detailSongs.length) { toast('暂无歌曲'); return }
          Player.playList(detailSongs, 0)
          toast('开始播放：' + detailMeta.name)
          break
        case 'play-all-search':
          if (!searchState.list.length) { toast('暂无歌曲'); return }
          Player.playList(searchState.list, 0)
          break
        case 'toggle-play':
          if (!Player.current) { toast('还没有选择歌曲，点一首歌开始播放'); break }
          Player.toggle(); break
        case 'swipe-toggle':
          /* 刷歌页整卡点击切播放；刚刚滑动翻页（flip.moved 或残留位移）时不误触发 */
          if (flip.moved || Math.abs(flip.dy) > 8) break
          if (!Player.current) { toast('还没有选择歌曲，点一首歌开始播放'); break }
          Player.toggle(); break
        case 'next-song':
          /* 刷歌页内切歌走书本翻页；其它页面仍是普通下一首 */
          if (onSwipePage() && swipeState.list.length) flipTo(1)
          else Player.next()
          break
        case 'prev-song':
          if (onSwipePage() && swipeState.list.length) flipTo(-1)
          else Player.prev()
          break
        case 'player-open':
          /* 空态迷你条为占位，不打开空白播放页 */
          if (!Player.current) { toast('还没有选择歌曲，点一首歌开始播放'); break }
          playerOpen(); break
        case 'player-close': playerClose(); break
        case 'open-queue': updateQueueSheet(); break
        case 'queue-play':
          Player.playAt(idx)
          sheetClose()
          break
        case 'queue-remove':
          Player.removeFromQueue(idx)
          updateQueueSheet()
          break
        case 'open-quality': soundOpen('quality'); break
        case 'open-fx': soundOpen('fx'); break
        case 'open-sound': soundOpen(el.getAttribute('data-tab') || 'quality'); break
        case 'sound-close': soundClose(); break
        case 'sound-tab': soundSwitchTab(el.getAttribute('data-tab')); break
        case 'q-pick': {
          var pick = el.getAttribute('data-q')
          Player.setQuality(pick)
          renderQualityPane()
          toast('音质：' + realLabel(pick))
          break
        }
        case 'q-strict': {
          var on = el.getAttribute('aria-pressed') === 'true'
          var next = on ? 'auto' : 'lossless'
          Player.setQuality(next)
          renderQualityPane()
          toast(on ? '已关闭严格无损（自动选档）' : '已开启严格无损：实测不是真无损就继续换源')
          break
        }
        case 'cycle-mode':
          if (Player.cyclePlayMode) {
            var nm = Player.cyclePlayMode()
            renderPlayMode()
            toast('播放模式：' + ((MODE_META[nm] || MODE_META.order).label))
          }
          break
        case 'open-sleep': openSleepSheet(); break
        case 'open-downloads': dlOpen(); break
        case 'dl-close': dlClose(); break
        case 'dl-play': {
          if (!dlState.list[idx]) break
          var dlQueue = dlState.list.map(dlSongOf)
          dlClose()
          Player.playList(dlQueue, idx)
          toast('播放本地：' + dlQueue[idx].name)
          break
        }
        case 'dl-remove': {
          var dlItem = dlState.list[idx]
          if (!dlItem) break
          API.downloadRemove(dlItem.name).then(function () {
            toast('已删除：' + dlItem.name)
            renderDl()
          }).catch(function (e) { toast(e.message) })
          break
        }
        case 'sleep-set':
          sleepSet(Number(el.getAttribute('data-min')) || 0)
          sheetClose()
          break
        case 'sleep-end-of-song': {
          sleepClear()
          var sg = Player.current
          if (!sg) { toast('还没有选择歌曲'); break }
          toast('播完本曲后自动停止')
          Player.once('ended', function () {
            try { if (Player.state.playing) Player.toggle() } catch (e) {}
            toast('本曲已播完，停止播放')
          })
          sheetClose()
          break
        }
        case 'open-more': openMoreSheet(); break
        case 'toggle-lyric': {
          var stage = $('#stage')
          var ly = stage.classList.toggle('mode-lyric')
          var sb = $('#btnLyric')
          if (sb) sb.classList.toggle('on', ly)
          break
        }
        case 'fx-toggle': fxToggle(); break
        case 'fx-reset': fxResetAll(); break
        case 'fx-smart': fxToggleSmart(); break
        case 'fx-r128': fxToggleR128(); break
        case 'fx-amb': fxPickAmb(el.getAttribute('data-mode')); break
        case 'fx-r128-target': fxPickR128Target(el.getAttribute('data-lufs')); break
        case 'dg-enable': dgEnableLive(); break
        case 'fx-eq-flat': fxEqFlat(); break
        case 'fx-eq-reset-preset': fxEqResetPreset(); break
        case 'fx-save': fxSaveCustom(); break
        case 'fx-del-preset': fxDelCustom(el.getAttribute('data-id')); break
        case 'fx-preset': fxPickPreset(el.getAttribute('data-id')); break
        case 'fx-rate': fxPickRate(el.getAttribute('data-rate')); break
        case 'download-current': {
          var dl = Player.current
          if (!dl) { toast('请先选择歌曲'); return }
          toast('已提交下载，完成后到「我的 → 我的下载」查看')
          API.download(dl, Player.state.quality || '320k').catch(function (e) { toast(e.message) })
          break
        }
        case 'set-quality':
          Player.setQuality(el.getAttribute('data-q'))
          sheetClose()
          toast('音质：' + realLabel(el.getAttribute('data-q')))
          break
        case 'open-addto': updateAddToSheet(); break
        case 'open-sources': updateSourcesSheet(); break
        case 'addto-playlist': {
          var song = Player.current
          if (!song) return
          API.playlistAdd(el.getAttribute('data-id'), song).then(function () {
            toast('已收藏到歌单')
            return loadLibrary()
          }).then(function () { sheetClose(); renderMine() })
            .catch(function (e) { toast(e.message) })
          break
        }
        case 'mine-avatar':
          openAvatarSheet()
          break
        case 'avatar-pick':
          pickAvatar()
          break
        case 'avatar-reset':
          sheetClose()
          profile.avatar = ''
          profileSave()
          toast('已恢复默认头像')
          break
        case 'mine-rename':
          dialogOpen({
            title: '修改昵称', value: profile.name || '本地音悦', placeholder: '请输入昵称', hint: '最多 12 个字',
            onOk: function (v) {
              v = String(v || '').trim()
              if (!v) { toast('昵称不能为空'); return false }
              if (v.length > 12) v = v.slice(0, 12)
              profile.name = v
              profileSave()
              toast('昵称已更新')
            },
          })
          break
        case 'open-newlist':
          sheetClose()
          dialogOpen({
            title: '新建歌单', placeholder: '请输入歌单名称', hint: '名称最多 20 个字',
            onOk: function (v) {
              if (!v) { toast('请输入名称'); return false }
              API.playlistCreate(v).then(function () {
                toast('歌单已创建')
                return loadLibrary()
              }).then(function () { renderMine() }).catch(function (e) { toast(e.message) })
            },
          })
          break
        case 'mylist-rename':
          dialogOpen({
            title: '重命名歌单', value: detailMeta.name,
            onOk: function (v) {
              if (!v) return false
              API.playlistRename(detailMeta.id, v).then(function () {
                return loadLibrary()
              }).then(function () {
                detailMeta.name = v
                $('#detailTitle').textContent = v
                renderDetail()
                renderMine()
              }).catch(function (e) { toast(e.message) })
            },
          })
          break
        case 'open-toplist': openToplist(el.getAttribute('data-id'), el.getAttribute('data-name')); break
        case 'open-playlist': openPlaylist(el.getAttribute('data-id'), el.getAttribute('data-name')); break
        case 'open-mylist': openMyList(el.getAttribute('data-id'), el.getAttribute('data-name')); break
        case 'open-fav': openFav(); break
        case 'open-history': openHistory(); break
        case 'open-ranking': openRanking(); break
        /* ---- 首页固定分类行 ---- */
        case 'cat-switch': catSwitch(el.getAttribute('data-cat')); break
        case 'cat-go': {
          var goCat = el.getAttribute('data-cat')
          closePanel('detail')
          switchTab('home')
          catSwitch(goCat)
          break
        }
        /* ---- 刷歌页 ---- */
        case 'swipe-shuffle': swipeShuffle(); break
        case 'daily-refresh': {
          toast('正在刷新每日数据…')
          loadDaily(true).then(function () {
            homeLoaded = true
            loadSwipeFeed(true)
            homeCat = homeCat || 'recommend'
            renderHome()
            toast('已同步 ' + (daily.date || ''))
          }).catch(function (e) { toast(e.message || '同步失败') })
          break
        }
        case 'swipe-fav-add': {
          var swIdx = el.hasAttribute('data-index') ? Number(el.getAttribute('data-index')) : swipeState.idx
          var swSong = swipeState.list[swIdx]
          if (!swSong) return
          updateAddToSheet(swSong)
          break
        }
        case 'swipe-fav': {
          ev.stopPropagation()
          var swFav = swipeState.list[swipeState.idx]
          if (!swFav) return
          toggleFav(swFav)
          break
        }
        case 'mini-fav': {
          ev.stopPropagation()
          if (!Player.current) { toast('还没有选择歌曲，点一首歌开始播放'); return }
          toggleFav(Player.current)
          break
        }
        case 'swipe-download': {
          var swDl = swipeState.list[Number(el.getAttribute('data-index'))]
          if (!swDl) return
          toast('已提交下载：' + (swDl.name || '未知歌曲'))
          API.download(swDl, Player.state.quality || '320k').catch(function (e) { toast(e.message) })
          break
        }
        case 'mode-cycle':
          /* 兼容旧数据属性，统一走播放模式切换 */
          if (Player.cyclePlayMode) {
            var nm2 = Player.cyclePlayMode()
            renderPlayMode()
            toast('播放模式：' + ((MODE_META[nm2] || MODE_META.order).label))
          }
          break
        case 'song-more': {
          var mIdx = Number(el.getAttribute('data-index'))
          var mSong = !isNaN(mIdx) ? swipeState.list[mIdx] : Player.current
          if (!mSong) return
          if (!(Player.current && Player.current.name === mSong.name)) Player.playList(swipeState.list, mIdx)
          setTimeout(openMoreSheet, 320)
          break
        }
        /* ---- 歌手分类 ---- */
        case 'artist-lang':
          artistLang = el.getAttribute('data-lang') || '全部'
          renderHome()
          break
        case 'artist-jump': {
          var key = el.getAttribute('data-key')
          var target = document.getElementById('ag-' + key)
          var sc = $('#homeScroll')
          if (target && sc) sc.scrollTo({ top: target.offsetTop - 8, behavior: 'smooth' })
          break
        }
        case 'artist-open': openArtist(el.getAttribute('data-name')); break
        /* ---- 歌词跟唱：点任意行跳转 ---- */
        case 'lyric-seek': {
          var ly = (Player.state.lyric || [])[Number(el.getAttribute('data-index'))]
          if (!ly) return
          Player.seek(ly.t || 0)
          toast('已跳转到 ' + fmtTime(ly.t || 0))
          break
        }
        case 'open-daily': openDaily(); break
        case 'open-hot': {
          var hotRank = null
          ;(daily.ranks || []).forEach(function (r) { if (!hotRank && /热歌/.test(r.name || '')) hotRank = r })
          if (hotRank) { openToplist(hotRank.id, hotRank.name); break }
          API.toplists().then(function (r) {
            var t = (r.list || [])[0]
            if (t) openToplist(t.id, t.name)
          })
          break
        }
        case 'detail-close': closePanel('detail'); break
        case 'detail-retry':
          if (detailMeta.type === 'toplist') openToplist(detailMeta.id, detailMeta.name)
          else if (detailMeta.type === 'playlist') openPlaylist(detailMeta.id, detailMeta.name)
          else if (detailMeta.type === 'history') openHistory()
          else if (detailMeta.type === 'ranking') openRanking()
          else if (detailMeta.type === 'daily') openDaily()
          else detailError('无法重试')
          break
        case 'search-open':
          openPanel('search')
          setTimeout(function () { try { $('#searchInput').focus() } catch (e) {} }, 260)
          break
        case 'search-close': closePanel('search'); break
        case 'search-submit': doSearch(false); break
        case 'search-more': if (!searchState.loading) doSearch(true); break
        case 'search-clear':
          $('#searchInput').value = ''
          searchState.list = []
          $('#searchBody').innerHTML = ''
          break
        case 'home-retry':
          stopAutoRetry()
          autoRetry.count = 0
          loadHome()
          break
        case 'mine-refresh':
          loadLibrary().then(function () { renderMine(); toast('已刷新') })
          break
        case 'import-open':
          importOpen()
          break
        case 'import-close':
          closePanel('import')
          break
        case 'import-submit':
          if (importState.step !== 'loading') importSubmit()
          break
        case 'import-confirm':
          if (importState.step !== 'loading') importConfirm()
          break
        case 'import-cancel':
          importReset()
          break
        case 'import-retry':
          if (importState.step !== 'loading') importSubmit()
          break
        case 'import-play':
          if (!importState.queue.length) { toast('暂无可播放曲目'); break }
          Player.playList(importState.queue, isNaN(idx) ? 0 : idx)
          break
        case 'import-open-list':
          if (!importState.saved || !importState.saved.id) { toast('还没有导入歌单'); break }
          closePanel('import')
          openMyList(importState.saved.id, importState.saved.name)
          break
        default: break
      }
    })

    /* 标签栏 */
    $$('#tabbar .tab').forEach(function (t) {
      t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')) })
    })

    /* 搜索平台切换 */
    $$('#searchSeg .seg-item').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('#searchSeg .seg-item').forEach(function (x) { x.classList.remove('active') })
        b.classList.add('active')
        searchState.platform = b.getAttribute('data-platform')
        if ($('#searchInput').value.trim()) doSearch(false)
      })
    })

    $('#searchInput').addEventListener('input', function () {
      $('.clear-btn').hidden = !this.value
    })
    $('#searchInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doSearch(false) }
    })

    /* 弹层关闭 */
    $$('[data-close]').forEach(function (el) {
      el.addEventListener('click', function () {
        if (el.getAttribute('data-close') === 'dialog') dialogClose()
        else sheetClose()
      })
    })

    /* 输入弹窗确定 */
    $('#dialogOk').addEventListener('click', function () {
      var d = $('#dialog')
      var fn = d._onOk
      var v = $('#dialogInput').value.trim()
      if (typeof fn === 'function') {
        var r = fn(v)
        if (r === false) return
      }
      dialogClose()
    })

    /* 进度条拖动（v3.8）：拖动中只更新界面与已播时间预览，松手才 seek 一次。
       旧版每个 touchmove 都调 Player.seek，既触发大量音频 seek 卡顿，
       又会被 timeupdate 回拽滑块，手感就是"拖不动、回弹"。 */
    var bar = $('#bar')
    if (bar) {
      var barDrag = false
      var lastPct = 0
      var barAt = function (ev) {
        var rect = bar.getBoundingClientRect()
        var tp = (ev.touches && ev.touches.length) ? ev.touches[0]
          : ((ev.changedTouches && ev.changedTouches.length) ? ev.changedTouches[0] : ev)
        var x = (tp.clientX || 0) - rect.left
        return Math.max(0, Math.min(1, x / (rect.width || 1)))
      }
      var barPreview = function (p) {
        lastPct = p
        bar.classList.add('dragging')
        var fill = $('#barFill')
        if (fill) fill.style.width = (p * 100) + '%'
        var knob = $('#barKnob')
        if (knob) knob.style.left = (p * 100) + '%'
        var tc = $('#tCur')
        var d = Player.state.duration || 0
        if (tc) tc.textContent = fmtTime(p * d)
      }
      var barDown = function (ev) {
        barDrag = true
        scrub.bar = true
        barPreview(barAt(ev))
      }
      var barMove = function (ev) {
        if (!barDrag) return
        if (ev.cancelable) ev.preventDefault()
        barPreview(barAt(ev))
      }
      var barUp = function () {
        if (!barDrag) return
        barDrag = false
        bar.classList.remove('dragging')
        var d = Player.state.duration || 0
        scrub.bar = false
        if (d > 0) Player.seek(lastPct * d)
        renderProgress()
      }
      bar.addEventListener('touchstart', barDown, { passive: true })
      bar.addEventListener('touchmove', barMove, { passive: false })
      bar.addEventListener('touchend', barUp)
      bar.addEventListener('touchcancel', barUp)
      bar.addEventListener('mousedown', function (ev) {
        barDown(ev)
        var mv = function (e2) { barMove(e2) }
        var up = function () {
          document.removeEventListener('mousemove', mv)
          document.removeEventListener('mouseup', up)
          barUp()
        }
        document.addEventListener('mousemove', mv)
        document.addEventListener('mouseup', up)
      })
    }

    /* 上下滑动手势切换播放页 */
    var touchStartY = 0
    var touchMoved = 0
    $('#mini').addEventListener('touchstart', function (e) { touchStartY = e.touches[0].clientY; touchMoved = 0 }, { passive: true })
    $('#mini').addEventListener('touchmove', function (e) { touchMoved = e.touches[0].clientY - touchStartY }, { passive: true })
    $('#mini').addEventListener('touchend', function () {
      if (touchMoved < -40 && Player.current) playerOpen()
    })
    $('#pHead').addEventListener('touchstart', function (e) { touchStartY = e.touches[0].clientY; touchMoved = 0 }, { passive: true })
    $('#pHead').addEventListener('touchmove', function (e) { touchMoved = e.touches[0].clientY - touchStartY }, { passive: true })
    $('#pHead').addEventListener('touchend', function () {
      if (touchMoved > 40) playerClose()
    })

    /* 歌词区点击跳转：点哪句就从哪句开始唱 */
    var lyrBox = $('#lyricList')
    if (lyrBox) {
      lyrBox.addEventListener('click', function (ev) {
        var line = ev.target.closest ? ev.target.closest('.lyric-line') : null
        if (!line || !lyrBox.contains(line)) return
        var lines = Array.prototype.slice.call(lyrBox.children)
        var i = lines.indexOf(line)
        var list = Player.state.lyric || []
        if (i < 0 || !list[i]) return
        Player.seek(list[i].t)
        toast('已跳到：' + String(list[i].text || '').slice(0, 16))
      })
    }

    /* 安卓返回键（WebView 内 history） */
    window.addEventListener('popstate', function () {
      if ($('#soundPanel').classList.contains('open')) { soundClose(); return }
      if ($('#sheet').classList.contains('open')) { sheetClose(); return }
      if ($('#player').classList.contains('open')) { playerClose(); return }
      if ($('#searchPanel').classList.contains('open')) { closePanel('search'); return }
      if ($('#detailPanel').classList.contains('open')) { closePanel('detail'); return }
    })
  }

  /* ---------------- 播放器事件绑定 ---------------- */
  function bindPlayer() {
    Player.on('song', function () {
      renderMini()
      renderPlayerSong()
      var cur = Player.current
      $$('.song').forEach(function (row) {
        var i = Number(row.getAttribute('data-index'))
        var songs = songsOfPanel()
        var s = songs[i]
        var on = s && cur && Player.songKey(s) === Player.songKey(cur)
        row.classList.toggle('playing', !!on)
      })
    })
    Player.on('state', function () {
      renderMini()
      renderPlayerState()
    })
    Player.on('progress', renderProgress)
    Player.on('lyric', renderLyric)
    Player.on('quality', function (q, kind) {
      /* kind: 'requested' 用户选的档位 / 'real' 音频流实测结果 */
      var cq = $('#cellQuality')
      if (cq) cq.textContent = realLabel(Player.state.quality)
      renderSoundBadges()
      if ($('#soundPanel').classList.contains('open')) renderQualityPane()
      /* v3.6：Hi-Res 实测偏低的提示已按老板要求移除，
         真实音质仍由音质面板的档位标签与角标如实呈现，不再弹 toast */
      if (kind === 'real' && q && Player.state.quality === 'lossless') {
        toast('严格无损：实测 ' + realLabel(q))
      }
    })
    Player.on('mode', renderPlayMode)
    Player.on('state', function () { updateSwipeState() })
    Player.on('song', function () {
      renderQualityPane()
      updateSwipeState()
    })
    Player.on('queue', function () {
      renderMini()
      updateMineStats()
    })
    Player.on('error', function (msg) { if (msg) toast(msg) })
  }

  /* ---------------- 安卓物理返回键 ----------------
     原生层 MainActivity.onBackPressed 会优先调用 window.__onBackPress()；
     返回 true 表示页面已消费该次返回（关掉了浮层），
     返回 false 时原生才会考虑历史后退或双击退出。
     优先级从上到下：音质音效面板 → 弹层 → 播放页 → 导入/搜索/详情页 */
  function handleBackPress() {
    function isOpen(sel) {
      var el = $(sel)
      return !!(el && el.classList.contains('open'))
    }
    /* 每一步单独兜底：任何一个关闭函数抛错都不能让整次返回变成 false，
       否则原生层会判定"页面不处理"，直接进入双击退出，表现为点两下就退出 */
    try {
      if (isOpen('#soundPanel')) { soundClose(); return true }
      if (isOpen('#sheet')) { sheetClose(); return true }
      if (isOpen('#player')) { playerClose(); return true }
      if (isOpen('#importPanel')) { closePanel('import'); return true }
      if (isOpen('#searchPanel')) { closePanel('search'); return true }
      if (isOpen('#detailPanel')) { closePanel('detail'); return true }
    } catch (err) {
      if (window.console) console.warn('[back] 关闭浮层失败: ' + err)
    }
    /* v3.6：刷歌页/我的等二级标签页按返回 = 回首页（只切页签，不打断播放） */
    var tab = document.body.getAttribute('data-tab') || 'home'
    if (tab !== 'home') {
      try {
        switchTab('home')
      } catch (err2) {
        if (window.console) console.warn('[back] 回首页失败: ' + err2)
      }
      return true
    }
    return false
  }
  /* 立即挂载钩子：必须在任何 UI 绑定之前就位，
     否则 bindActions/bindPlayer 里一旦抛错，原生层会认为页面没有 __onBackPress */
  window.__onBackPress = handleBackPress

  /* ---------------- 启动 ---------------- */
  function boot() {
    /* 单点绑定失败不能拖垮整个启动流程（尤其是返回键钩子） */
    try { bindActions() } catch (e1) { if (window.console) console.warn('[boot] bindActions: ' + e1) }
    try { bindPlayer() } catch (e2) { if (window.console) console.warn('[boot] bindPlayer: ' + e2) }
    /* 交给原生层调用：物理返回键优先归页面处理（模块加载时已挂载，这里兜底重申） */
    window.__onBackPress = handleBackPress
    /* 冷启动轮询进度实时回显：探测中显示"第 n 次 / n 秒"，避免误以为卡死 */
    if (API.onStatus) {
      API.onStatus(function () {
        if (homeLoaded) return
        var el = document.querySelector('#homeScroll .loading span:last-child')
        if (el) el.textContent = homeLoadingText()
      })
    }
    renderMini()
    try { bindMiniBall() } catch (e3) { if (window.console) console.warn('[boot] bindMiniBall: ' + e3) }
    try { bindMiniBar() } catch (e0) { if (window.console) console.warn('[boot] bindMiniBar: ' + e0) }
    renderProgress()
    renderPlayerState()
    renderPlayMode()
    renderSoundBadges()

    Player.init().then(function () {
      renderPlayMode()
      renderSoundBadges()
      renderQualityPane()
    })

    loadLibrary().then(function () { renderMine() })
    loadHome()
    bindSwipeGesture()
    bindLyricDrag()
  }

  /* 刷歌页竖向滑动：由 pointer 驱动的翻页动效接管（flipDown/flipMove/flipUp）；
     此处只保留桌面/模拟器滚轮兜底，避免 touch 与 pointer 双重触发导致一次滑动跳两首 */
  function bindSwipeGesture() {
    var box = $('#swipeScroll')
    if (!box) return
    bindSwipeFlip()
    var lock = 0
    box.addEventListener('wheel', function (e) {
      var now = Date.now()
      if (now - lock < 500) return
      if (Math.abs(e.deltaY) < 12) return
      lock = now
      swipeMove(e.deltaY > 0 ? 1 : -1)
    }, { passive: true })
  }

  /* ---------------- v3.9 通用点击特效：水波纹 + 播放键脉冲 ----------------
     两个播放器共用同一套：任意圆形/胶囊按钮按下时从触点扩散一圈光，
     播放键额外抖出一圈脉冲环，用来强化"按到了"的反馈。
     v55（真机问题 3）：歌曲行/列表单元格/卡片也纳入水波纹范围 —— 之前只有按钮有反馈，
     点歌时除了切歌没有任何手感。 */
  var RIP_SEL = '.p-play,.p-ctrl-btn,.p-icon-btn,.p-act,.swipe-ctrl .sctrl,.sw-act,.mini-btn,.swipe-cover,.song,.cell,.quick,.cat,.hcard'

  /* v3.9：只改 <use> 的 href，不重建 innerHTML —— 否则按钮内的水波纹会被冲掉 */
  function setBtnIcon(btn, iconId) {
    if (!btn) return
    var use = btn.querySelector('use')
    if (use) {
      use.setAttribute('href', '#' + iconId)
      use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + iconId)
      return
    }
    btn.innerHTML = ico(iconId)
  }

  function spawnRipple(el, x, y) {
    var r = el.getBoundingClientRect()
    if (!r.width || !r.height) return
    var d = Math.max(r.width, r.height) * 2
    var dot = document.createElement('span')
    dot.className = 'mv-ripple'
    dot.style.width = d + 'px'
    dot.style.height = d + 'px'
    dot.style.left = Math.round(x - r.left) + 'px'
    dot.style.top = Math.round(y - r.top) + 'px'
    el.appendChild(dot)
    setTimeout(function () {
      if (dot.parentNode) dot.parentNode.removeChild(dot)
    }, 600)
  }

  document.addEventListener('pointerdown', function (e) {
    var t = e.target
    if (!t || !t.closest) return
    var el = t.closest(RIP_SEL)
    if (!el) return
    spawnRipple(el, e.clientX, e.clientY)
    var isMain = el.classList.contains('p-play') ||
      (el.classList.contains('sctrl') && el.classList.contains('main'))
    if (isMain) {
      el.classList.remove('pulse')
      void el.offsetWidth
      el.classList.add('pulse')
      setTimeout(function () { el.classList.remove('pulse') }, 560)
    }
  }, true)

  /* ---------------- v55 按压反馈（真机问题 3：点歌没手感） ----------------
     iOS 的 WKWebView 不实现 navigator.vibrate，Web 层拿不到真实震动马达，
     所以这里做等效触感：按下瞬间立刻缩放 + 变暗（.is-press），
     再叠加一层从触点扩散的水波纹。两者都在 pointerdown 阶段同步触发，
     不等动画帧，手指一落就有反馈。 */
  var PRESS_SEL = RIP_SEL + ',#tabbar .tab,.sp-tab,.swipe-toggle,.panel-back,.p-ico,.mini-main'
  var pressEl = null
  var pressTimer = 0

  function clearPress() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0 }
    if (pressEl) {
      pressEl.classList.remove('is-press')
      pressEl = null
    }
  }

  document.addEventListener('pointerdown', function (e) {
    var t = e.target
    if (!t || !t.closest) return
    var el = t.closest(PRESS_SEL)
    if (!el) return
    clearPress()
    pressEl = el
    el.classList.add('is-press')
    /* 兜底：长按/系统手势吞掉 pointerup 时，400ms 后自动复位，避免一直缩着 */
    pressTimer = setTimeout(clearPress, 400)
  }, true)

  document.addEventListener('pointerup', clearPress, true)
  document.addEventListener('pointercancel', clearPress, true)
  document.addEventListener('pointerleave', clearPress, true)
  window.addEventListener('scroll', clearPress, true)

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
