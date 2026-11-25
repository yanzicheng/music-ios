/* ===========================================================
   音效引擎（Web Audio API，对齐 QQ音乐 的音效能力）
   -----------------------------------------------------------
   信号链：
     <audio> → MediaElementSource → preGain
             → 10 段 EQ(31/62/125/250/500/1k/2k/4k/8k/16k)
             → 低音增强(lowshelf 90Hz) → 空间环绕(delay+feedback)
             → 立体声宽度(M/S 矩阵) → 智能音量(压缩器) → master(淡入淡出) → 输出

   关键约束（已按此实现）：
   1) createMediaElementSource 对同一个 <audio> 只能调用一次，节点全程复用，切歌不重建；
   2) AudioContext 必须在用户手势内 resume，否则输出静音；首次开启音效时才建链，
      避免"没开音效却因 ctx 挂起导致没声音"；
   3) 所有参数（预设/EQ/宽度/低音/智能音量/淡入淡出/速度）随 config.json 持久化；
   4) EQ 曲线由 BiquadFilterNode.getFrequencyResponse 实时计算，与真实节点一致。
   =========================================================== */
(function () {
  'use strict'

  var BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
  var BAND_LABEL = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']

  /* 预设：eq 为 10 段增益(dB)；bass/width/ambience 为 0~1；comp=智能音量平衡 */
  var PRESETS = {
    original:     { name: '原声',        eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],              bass: 0,    width: 0,    ambience: 0,    comp: false },
    superbass:    { name: '超重低音',    eq: [6, 5, 3, 1, 0, -1, -1, 0, 1, 0],             bass: 0.75, width: 0.15, ambience: 0,    comp: true },
    vocal:        { name: '清澈人声',    eq: [-2, -2, 0, 2, 4, 4, 3, 1, 0, -1],            bass: 0,    width: 0,    ambience: 0,    comp: true },
    surround3d:   { name: '3D环绕沉浸',  eq: [1, 2, 2, 1, 0, 0, 1, 2, 3, 2],               bass: 0.25, width: 0.9,  ambience: 0.55, comp: true },
    concert:      { name: '现场演唱会',  eq: [3, 3, 2, 1, 0, 0, 1, 2, 3, 2],               bass: 0.4,  width: 0.65, ambience: 0.75, comp: true },
    rock:         { name: '摇滚',        eq: [5, 4, 2, 0, -1, -1, 1, 3, 4, 3],             bass: 0.5,  width: 0.3,  ambience: 0.1,  comp: true },
    pop:          { name: '流行',        eq: [2, 2, 1, 0, 1, 1, 2, 2, 1, 0],               bass: 0.2,  width: 0.2,  ambience: 0,    comp: true },
    classical:    { name: '古典',        eq: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],               bass: 0.1,  width: 0.45, ambience: 0.35, comp: false },
    jazz:         { name: '爵士',        eq: [3, 2, 1, 0, 1, 1, 1, 2, 2, 1],               bass: 0.3,  width: 0.25, ambience: 0.2,  comp: true },
    electronic:   { name: '电子',        eq: [5, 4, 3, 1, 0, 0, 2, 3, 4, 3],               bass: 0.6,  width: 0.5,  ambience: 0.25, comp: true },
  }

  var cfg = {
    enabled: false,
    preset: 'original',
    eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    width: 0,
    bass: 0,
    smartVolume: false,
    fade: 0,
    rate: 1,
    customPresets: {},
  }

  var audioEl = null
  var ctx = null
  var attached = false
  var nodes = null
  var persistTimer = null
  var applying = false
  var bypassed = false

  function clamp(v, lo, hi) {
    v = Number(v)
    if (!isFinite(v)) return lo
    return v < lo ? lo : (v > hi ? hi : v)
  }

  function cloneCfg() {
    return {
      enabled: !!cfg.enabled,
      preset: cfg.preset,
      eq: cfg.eq.slice(),
      width: cfg.width,
      bass: cfg.bass,
      smartVolume: !!cfg.smartVolume,
      fade: cfg.fade,
      rate: cfg.rate,
      customPresets: JSON.parse(JSON.stringify(cfg.customPresets || {})),
    }
  }

  /* ---------------- 建链（一次性） ---------------- */
  function build() {
    if (attached || !audioEl) return attached
    var AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return false
    try {
      ctx = new AC()
      nodes = {}
      nodes.src = ctx.createMediaElementSource(audioEl)
      nodes.pre = ctx.createGain()
      nodes.pre.gain.value = 1

      nodes.eq = BANDS.map(function (f, i) {
        var bq = ctx.createBiquadFilter()
        bq.type = i === 0 ? 'lowshelf' : (i === BANDS.length - 1 ? 'highshelf' : 'peaking')
        bq.frequency.value = f
        bq.Q.value = 1.0
        bq.gain.value = 0
        return bq
      })

      nodes.bass = ctx.createBiquadFilter()
      nodes.bass.type = 'lowshelf'
      nodes.bass.frequency.value = 90
      nodes.bass.gain.value = 0

      /* 空间环绕：短延迟 + 反馈，湿声比例由预设控制 */
      nodes.delay = ctx.createDelay(0.2)
      nodes.delay.delayTime.value = 0.022
      nodes.fb = ctx.createGain()
      nodes.fb.gain.value = 0
      nodes.wet = ctx.createGain()
      nodes.wet.gain.value = 0
      nodes.dry = ctx.createGain()
      nodes.dry.gain.value = 1
      nodes.ambSum = ctx.createGain()

      /* 立体声宽度：L' = L*(1+w/2) - R*(w/2)，R' = R*(1+w/2) - L*(w/2) */
      nodes.split = ctx.createChannelSplitter(2)
      nodes.merge = ctx.createChannelMerger(2)
      nodes.gLL = ctx.createGain()
      nodes.gRR = ctx.createGain()
      nodes.gLR = ctx.createGain()
      nodes.gRL = ctx.createGain()

      nodes.comp = ctx.createDynamicsCompressor()
      nodes.comp.threshold.value = -22
      nodes.comp.knee.value = 26
      nodes.comp.ratio.value = 4
      nodes.comp.attack.value = 0.004
      nodes.comp.release.value = 0.25

      nodes.master = ctx.createGain()
      nodes.master.gain.value = 1

      /* 连接：src → pre → eq[0..9] → bass */
      nodes.src.connect(nodes.pre)
      var cursor = nodes.pre
      for (var i = 0; i < nodes.eq.length; i++) {
        cursor.connect(nodes.eq[i])
        cursor = nodes.eq[i]
      }
      cursor.connect(nodes.bass)

      /* 干声 */
      nodes.bass.connect(nodes.dry)
      nodes.dry.connect(nodes.ambSum)
      /* 湿声 + 反馈 */
      nodes.bass.connect(nodes.delay)
      nodes.delay.connect(nodes.fb)
      nodes.fb.connect(nodes.delay)
      nodes.delay.connect(nodes.wet)
      nodes.wet.connect(nodes.ambSum)

      /* 宽度矩阵 */
      nodes.ambSum.connect(nodes.split)
      nodes.split.connect(nodes.gLL, 0)
      nodes.split.connect(nodes.gRL, 0)
      nodes.split.connect(nodes.gRR, 1)
      nodes.split.connect(nodes.gLR, 1)
      nodes.gLL.connect(nodes.merge, 0, 0)
      nodes.gRL.connect(nodes.merge, 0, 1)
      nodes.gRR.connect(nodes.merge, 0, 1)
      nodes.gLR.connect(nodes.merge, 0, 0)

      nodes.merge.connect(nodes.comp)
      nodes.comp.connect(nodes.master)
      nodes.master.connect(ctx.destination)

      attached = true
      apply()
      return true
    } catch (e) {
      console.warn('[AudioFX] 建链失败，回退原生播放', e)
      attached = false
      return false
    }
  }

  function resume() {
    if (!ctx) return
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      ctx.resume().catch(function () {})
    }
  }

  /* ---------------- 参数下发 ---------------- */
  function flat() {
    /* 全平：关闭音效时严格还原为原声（不动用户音量） */
    cfg.eq = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    cfg.width = 0
    cfg.bass = 0
    cfg.smartVolume = false
  }

  /* 音效关闭时真正的旁路：源节点直连输出，不再经过整条处理链（零着色、零延迟） */
  function setRoute(bypass) {
    if (!nodes || !ctx) return
    if (bypass === bypassed) return
    try { nodes.src.disconnect() } catch (e) {}
    try {
      if (bypass) nodes.src.connect(ctx.destination)
      else nodes.src.connect(nodes.pre)
    } catch (e) { console.warn('[AudioFX] 旁路切换失败', e) }
    bypassed = bypass
  }

  function apply() {
    if (!nodes || !ctx) return
    applying = true
    try {
      var t = ctx.currentTime
      var on = !!cfg.enabled
      setRoute(!on)
      var eq = on ? cfg.eq : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      for (var i = 0; i < nodes.eq.length; i++) {
        var g = clamp(eq[i] || 0, -12, 12)
        nodes.eq[i].gain.setTargetAtTime(g, t, 0.02)
      }
      var bassGain = on ? clamp(cfg.bass, 0, 1) * 12 : 0
      nodes.bass.gain.setTargetAtTime(bassGain, t, 0.02)

      var preset = PRESETS[cfg.preset] || PRESETS.original
      var amb = on ? clamp((preset.ambience || 0) + (cfg.preset === 'original' ? 0 : 0), 0, 1) : 0
      /* 自定义预设也允许自带空间感：统一取预设值，宽度/低音以用户滑杆为准 */
      nodes.wet.gain.setTargetAtTime(amb * 0.45, t, 0.03)
      nodes.fb.gain.setTargetAtTime(amb * 0.2, t, 0.03)
      nodes.dry.gain.setTargetAtTime(1, t, 0.02)

      var w = on ? clamp(cfg.width, 0, 1) : 0
      var main = 1 + w / 2
      var cross = -w / 2
      nodes.gLL.gain.setTargetAtTime(main, t, 0.02)
      nodes.gRR.gain.setTargetAtTime(main, t, 0.02)
      nodes.gLR.gain.setTargetAtTime(cross, t, 0.02)
      nodes.gRL.gain.setTargetAtTime(cross, t, 0.02)

      /* 智能音量：开启时压低门限提高一致性，关闭时阈值拉到 0 相当于透明 */
      if (on && cfg.smartVolume) {
        nodes.comp.threshold.setTargetAtTime(-24, t, 0.05)
        nodes.comp.ratio.setTargetAtTime(4, t, 0.05)
        nodes.comp.knee.setTargetAtTime(26, t, 0.05)
      } else {
        nodes.comp.threshold.setTargetAtTime(0, t, 0.05)
        nodes.comp.ratio.setTargetAtTime(1, t, 0.05)
        nodes.comp.knee.setTargetAtTime(0, t, 0.05)
      }

      if (audioEl) {
        var rate = clamp(cfg.rate || 1, 0.5, 2)
        try {
          audioEl.playbackRate = rate
          audioEl.preservesPitch = rate !== 1
          if ('webkitPreservesPitch' in audioEl) audioEl.webkitPreservesPitch = rate !== 1
        } catch (e) {}
      }
    } finally {
      applying = false
    }
  }

  /* ---------------- 持久化（config.json） ---------------- */
  function persist() {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(function () {
      persistTimer = null
      try {
        if (window.API && API.setConfig) API.setConfig({ audioFx: cloneCfg() }).catch(function () {})
      } catch (e) {}
    }, 350)
  }

  /* ---------------- 对外 API ---------------- */
  var AudioFX = {
    BANDS: BANDS,
    BAND_LABEL: BAND_LABEL,
    PRESETS: PRESETS,

    /** 载入持久化配置（不建链，避免未开音效时被 AudioContext 挂起影响出声） */
    load: function (saved) {
      if (saved && typeof saved === 'object') {
        cfg.enabled = !!saved.enabled
        cfg.preset = saved.preset || 'original'
        cfg.eq = (Array.isArray(saved.eq) && saved.eq.length === 10 ? saved.eq : cfg.eq).map(function (v) { return clamp(v, -12, 12) })
        cfg.width = clamp(saved.width || 0, 0, 1)
        cfg.bass = clamp(saved.bass || 0, 0, 1)
        cfg.smartVolume = !!saved.smartVolume
        cfg.fade = clamp(saved.fade || 0, 0, 5)
        cfg.rate = clamp(saved.rate || 1, 0.5, 2)
        cfg.customPresets = saved.customPresets && typeof saved.customPresets === 'object' ? saved.customPresets : {}
      }
      if (audioEl && cfg.enabled) { build(); resume(); apply() }
      return cloneCfg()
    },

    /** 绑定 <audio>（必须在用户手势中调用；只在需要音效时真正建链） */
    attach: function (el, force) {
      audioEl = el
      if (!attached && (force || cfg.enabled)) { build(); }
      resume()
      return attached
    },

    /** 开启/关闭音效（首次开启会建链，必须在点击里调用） */
    setEnabled: function (on) {
      cfg.enabled = !!on
      if (cfg.enabled) {
        build()
        resume()
      }
      apply()
      persist()
      return cfg.enabled
    },

    /** 切预设（预设只覆盖 EQ/低音/宽度/空间，不覆盖淡入淡出与速度） */
    setPreset: function (key) {
      var p = PRESETS[key] || cfg.customPresets[key]
      if (!p) return false
      cfg.preset = key
      cfg.eq = (p.eq || cfg.eq).slice()
      cfg.bass = clamp(p.bass || 0, 0, 1)
      cfg.width = clamp(p.width || 0, 0, 1)
      cfg.smartVolume = p.comp === undefined ? cfg.smartVolume : !!p.comp
      if (!cfg.enabled) cfg.enabled = true
      build()
      resume()
      apply()
      persist()
      return true
    },

    setEqBand: function (i, db) {
      i = Number(i)
      if (!(i >= 0 && i < 10)) return
      cfg.eq[i] = clamp(db, -12, 12)
      cfg.preset = 'custom'
      if (cfg.enabled) build()
      apply()
      persist()
    },

    setEqAll: function (arr) {
      if (!Array.isArray(arr) || arr.length !== 10) return
      cfg.eq = arr.map(function (v) { return clamp(v, -12, 12) })
      apply()
      persist()
    },

    setWidth: function (v) { cfg.width = clamp(v, 0, 1); apply(); persist() },
    setBass: function (v) { cfg.bass = clamp(v, 0, 1); apply(); persist() },
    setSmartVolume: function (b) { cfg.smartVolume = !!b; apply(); persist() },
    setFade: function (s) { cfg.fade = clamp(s, 0, 5); persist() },
    setRate: function (r) { cfg.rate = clamp(r, 0.5, 2); apply(); persist() },

    /** 当前是否为"纯原声"（无任何音效着色） */
    isNeutral: function () {
      if (!cfg.enabled) return true
      var p = PRESETS[cfg.preset]
      if (!p && !cfg.customPresets[cfg.preset]) return cfg.eq.every(function (v) { return v === 0 }) && cfg.bass === 0 && cfg.width === 0
      return cfg.preset === 'original' && cfg.bass === 0 && cfg.width === 0
    },

    /** 保存当前 EQ/低音/宽度为自定义预设 */
    savePreset: function (name) {
      name = String(name || '').trim()
      if (!name) return false
      cfg.customPresets[name] = { name: name, eq: cfg.eq.slice(), bass: cfg.bass, width: cfg.width, smartVolume: cfg.smartVolume, custom: true }
      cfg.preset = name
      persist()
      return true
    },

    removePreset: function (name) {
      if (!cfg.customPresets[name]) return false
      delete cfg.customPresets[name]
      persist()
      return true
    },

    /** EQ 真实响应曲线（直接读实时滤波节点，保证曲线与听到的一致） */
    curve: function (points) {
      points = points || 96
      var freqs = new Float32Array(points)
      for (var i = 0; i < points; i++) {
        /* 20Hz ~ 20kHz 对数分布 */
        freqs[i] = 20 * Math.pow(1000, i / (points - 1))
      }
      var total = new Float32Array(points)
      for (var k = 0; k < points; k++) total[k] = 0
      if (!nodes) {
        return { freqs: Array.prototype.slice.call(freqs), db: Array.prototype.slice.call(total) }
      }
      var mag = new Float32Array(points)
      var phase = new Float32Array(points)
      for (var n = 0; n < nodes.eq.length; n++) {
        nodes.eq[n].getFrequencyResponse(freqs, mag, phase)
        for (var m = 0; m < points; m++) total[m] += 20 * Math.log10(Math.max(mag[m], 1e-6))
      }
      return { freqs: Array.prototype.slice.call(freqs), db: Array.prototype.slice.call(total) }
    },

    fadeIn: function () {
      if (!nodes || !ctx || !cfg.enabled || !cfg.fade) return
      var t = ctx.currentTime
      var g = nodes.master.gain
      g.cancelScheduledValues(t)
      g.setValueAtTime(0.0001, t)
      g.linearRampToValueAtTime(1, t + clamp(cfg.fade, 0, 5))
    },

    fadeOut: function (done) {
      if (!nodes || !ctx || !cfg.enabled || !cfg.fade) { if (done) done(); return }
      var t = ctx.currentTime
      var g = nodes.master.gain
      g.cancelScheduledValues(t)
      g.setValueAtTime(g.value, t)
      g.linearRampToValueAtTime(0.0001, t + clamp(cfg.fade, 0, 5))
      setTimeout(function () {
        try { g.setValueAtTime(1, ctx.currentTime) } catch (e) {}
        if (done) done()
      }, cfg.fade * 1000 + 30)
    },

    state: cloneCfg,
    /** 实时输出探针（挂在 master 之后，用于频响/波形取证，不影响听感） */
    tap: function () {
      if (!nodes || !ctx) return null
      if (!nodes.tapNode) {
        var a = ctx.createAnalyser()
        a.fftSize = 2048
        a.smoothingTimeConstant = 0.35
        nodes.master.connect(a)
        nodes.tapNode = a
      }
      return nodes.tapNode
    },
    isBypassed: function () { return bypassed },
    reapply: apply,
    isReady: function () { return attached && !!ctx && ctx.state === 'running' },
    ctxState: function () { return ctx ? ctx.state : 'none' },
    resume: resume,
  }

  window.AudioFX = AudioFX
})()
