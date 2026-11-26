/* ===========================================================
   音效引擎 v2（Web Audio API，对齐 QQ音乐 的音效能力 + 开源音质增强）
   -----------------------------------------------------------
   信号链（v56 重构）：
     <audio> → MediaElementSource → preGain
             → 10 段 EQ(31/62/125/250/500/1k/2k/4k/8k/16k)
             → 分频低音（Linkwitz-Riley 4 阶 @160Hz）
                  ├ low  → lowGain(0~+9dB) ──────────────┐
                  └ low  → 谐波激励(WaveShaper 软饱和) ──┤
                    high → ─────────────────────────────┤
                                                        ↓
                                     空间感（卷积 IR / 经典延迟 / 关闭）
                                                        ↓
                              立体声宽度（真 M/S 增益 + 相位一致性约束）
                                                        ↓
                              EBU R128 响度标准化（动态增益 + 峰值保护）
                                                        ↓
                                      安全限幅器 → master(淡入淡出) → 输出

   诊断探针（不参与听感，全部接 0 增益汇点后进 destination 以被图拉动）：
     L/R K 加权 → 瞬时/短时/积分 LUFS；输出 L/R → 采样峰值/削波/电平/频谱；
     Mid/Side → 声道相关度（用于宽度矩阵的相位一致性约束）。

   关键约束（沿用 v1 结论）：
   1) createMediaElementSource 对同一个 <audio> 只能调用一次，节点全程复用，切歌不重建；
   2) AudioContext 必须在用户手势内 resume，否则输出静音；首次开启音效时才建链；
   3) 所有参数随 config.json 持久化；
   4) 音效关闭时走真旁路：源节点直连 destination，不经任何处理节点（零着色零延迟）。
   =========================================================== */
(function () {
  'use strict'

  var BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
  var BAND_LABEL = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']

  /* 预设：eq 为 10 段增益(dB)；bass/width/ambience 为 0~1；comp=响度标准化 */
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

  /* 空间感实现方式：卷积 IR（默认）/ 旧版 delay+feedback / 关闭 */
  var AMB_MODES = [
    { k: 'ir', name: '卷积 IR' },
    { k: 'legacy', name: '经典延迟' },
    { k: 'off', name: '关闭' },
  ]

  /* 响度标准化目标（LUFS）：流媒体常用 -14，广播 -23，移动端小喇叭适中 -12~-16 */
  var R128_TARGETS = [-10, -12, -14, -16, -18]

  var CROSSOVER = 160      /* 分频点 Hz */
  var MAX_BASS_DB = 9      /* 低音最大提升，避免硬拉导致浑浊 */
  var IR_SECONDS = 1.2     /* 合成 IR 长度 */

  var cfg = {
    enabled: false,
    preset: 'original',
    eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    width: 0,
    bass: 0,
    exciter: 0,
    r128: false,
    r128Target: -14,
    ambienceMode: 'ir',
    smartVolume: false,     /* 兼容字段：等价于 r128 */
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
  var streamInfo = null
  var irBuilt = false

  /* 实时测量状态 */
  var meter = {
    timer: null,
    blocks: [],
    integ: [],
    lastIntegPush: 0,
    songStart: 0,
    fast: true,
    mL: 0,
    mR: 0,
    mCur: NaN,
    sCur: NaN,
    iCur: NaN,
    peak: 0,
    peakHold: 0,
    rmsL: 0,
    rmsR: 0,
    clip: 0,
    corr: 1,
    gainDb: 0,
    gainS: 1,
    widthFactor: 1,
    bufL: null,
    bufR: null,
    bufOL: null,
    bufOR: null,
    bufMid: null,
    bufSide: null,
    spec: null,
  }

  function clamp(v, lo, hi) {
    v = Number(v)
    if (!isFinite(v)) return lo
    return v < lo ? lo : (v > hi ? hi : v)
  }

  function dbToGain(db) { return Math.pow(10, db / 20) }
  function gainToDb(g) { return g > 0 ? 20 * Math.log10(g) : -Infinity }

  function cloneCfg() {
    return {
      enabled: !!cfg.enabled,
      preset: cfg.preset,
      eq: cfg.eq.slice(),
      width: cfg.width,
      bass: cfg.bass,
      exciter: cfg.exciter,
      r128: !!cfg.r128,
      r128Target: cfg.r128Target,
      ambienceMode: cfg.ambienceMode,
      smartVolume: !!cfg.r128,
      fade: cfg.fade,
      rate: cfg.rate,
      customPresets: JSON.parse(JSON.stringify(cfg.customPresets || {})),
    }
  }

  /* ---------------- 合成脉冲响应（不引入任何外部音频素材） ----------------
     做法：短前延迟 + 4 个早期反射 + 指数衰减的一阶低通噪声尾，左右声道用
     不同随机种子做去相关，最后统一归一化到 0.5 峰值，保证卷积增益可预期。 */
  function makeIR(seconds) {
    var sr = ctx.sampleRate
    var len = Math.max(1, Math.floor(sr * seconds))
    var buf = ctx.createBuffer(2, len, sr)
    var pre = Math.max(1, Math.floor(sr * 0.014))
    var taps = [0.006, 0.015, 0.027, 0.043]

    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch)
      var seed = ch === 0 ? 20190301 : 77003
      var lp = 0
      var i
      for (i = 0; i < len; i++) d[i] = 0
      for (i = pre; i < len; i++) {
        var tt = (i - pre) / (len - pre)
        var env = Math.pow(1 - tt, 2.4) * Math.exp(-2.6 * tt)
        /* 线性同余伪随机，结果可复现，不用 Math.random 以免每次听感不同 */
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        var rnd = (seed / 0x7fffffff) * 2 - 1
        lp += 0.34 * (rnd - lp)             /* 一阶低通：让尾巴更暗，接近厅堂 */
        d[i] = lp * env
      }
      for (var k = 0; k < taps.length; k++) {
        var idx = pre + Math.floor(sr * (taps[k] + ch * 0.0021))
        if (idx < len) d[idx] += (k % 2 === 0 ? 0.55 : -0.42) / (k + 1)
      }
    }

    var peak = 0
    for (var c2 = 0; c2 < 2; c2++) {
      var data = buf.getChannelData(c2)
      for (var j = 0; j < data.length; j++) {
        var a = data[j] < 0 ? -data[j] : data[j]
        if (a > peak) peak = a
      }
    }
    if (peak > 0) {
      var g = 0.5 / peak
      for (var c3 = 0; c3 < 2; c3++) {
        var dt = buf.getChannelData(c3)
        for (var n = 0; n < dt.length; n++) dt[n] *= g
      }
    }
    return buf
  }

  function ensureIR() {
    if (irBuilt || !nodes || !nodes.conv || !ctx) return
    try {
      nodes.conv.buffer = makeIR(IR_SECONDS)
      nodes.conv.normalize = false
      irBuilt = true
    } catch (e) {
      console.warn('[AudioFX] IR 生成失败，卷积空间感不可用', e)
      irBuilt = false
    }
  }

  /* 谐波激励曲线：软饱和（tanh 近似），给小喇叭补低频听感而不硬拉增益 */
  function makeExciterCurve() {
    var n = 1024
    var curve = new Float32Array(n)
    var k = 2.2
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1
      curve[i] = ((1 + k) * x) / (1 + k * (x < 0 ? -x : x))
    }
    return curve
  }

  /* ---------------- 建链（一次性） ---------------- */
  function build() {
    if (attached || !audioEl) return attached
    var AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return false
    try {
      ctx = new AC()
      nodes = {}

      /* 0 增益汇点：让所有"只为测量"的支路被音频图拉动，又不产生声音 */
      nodes.sink = ctx.createGain()
      nodes.sink.gain.value = 0
      nodes.sink.connect(ctx.destination)

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

      /* ---- 分频低音：Linkwitz-Riley 4 阶 = 两级 Butterworth 2 阶级联 ---- */
      var q = 0.7071
      nodes.lp1 = ctx.createBiquadFilter()
      nodes.lp1.type = 'lowpass'
      nodes.lp1.frequency.value = CROSSOVER
      nodes.lp1.Q.value = q
      nodes.lp2 = ctx.createBiquadFilter()
      nodes.lp2.type = 'lowpass'
      nodes.lp2.frequency.value = CROSSOVER
      nodes.lp2.Q.value = q

      nodes.hp1 = ctx.createBiquadFilter()
      nodes.hp1.type = 'highpass'
      nodes.hp1.frequency.value = CROSSOVER
      nodes.hp1.Q.value = q
      nodes.hp2 = ctx.createBiquadFilter()
      nodes.hp2.type = 'highpass'
      nodes.hp2.frequency.value = CROSSOVER
      nodes.hp2.Q.value = q

      nodes.lowGain = ctx.createGain()
      nodes.lowGain.gain.value = 1

      /* 谐波激励：低音支路并联一路软饱和，产生二次/三次谐波补偿低频感知 */
      nodes.excDrive = ctx.createGain()
      nodes.excDrive.gain.value = 1
      nodes.shaper = ctx.createWaveShaper()
      nodes.shaper.curve = makeExciterCurve()
      nodes.shaper.oversample = '4x'
      nodes.excWet = ctx.createGain()
      nodes.excWet.gain.value = 0

      nodes.bandSum = ctx.createGain()
      nodes.bandSum.gain.value = 1

      /* ---- 空间感：卷积 IR（默认）+ 旧版 delay/feedback（可选） ---- */
      nodes.ambDry = ctx.createGain()
      nodes.ambDry.gain.value = 1
      nodes.postAmb = ctx.createGain()
      nodes.postAmb.gain.value = 1

      try {
        nodes.conv = ctx.createConvolver()
        nodes.conv.normalize = false
        nodes.irWet = ctx.createGain()
        nodes.irWet.gain.value = 0
      } catch (e) {
        console.warn('[AudioFX] 当前 WebView 不支持卷积节点', e)
        nodes.conv = null
        nodes.irWet = null
      }

      nodes.delay = ctx.createDelay(0.2)
      nodes.delay.delayTime.value = 0.022
      nodes.fb = ctx.createGain()
      nodes.fb.gain.value = 0
      nodes.wet = ctx.createGain()
      nodes.wet.gain.value = 0

      /* ---- 立体声宽度：真 M/S 增益（M=(L+R)/2, S=(L-R)/2） ---- */
      nodes.wSplit = ctx.createChannelSplitter(2)
      nodes.wMerge = ctx.createChannelMerger(2)
      nodes.mL = ctx.createGain(); nodes.mL.gain.value = 0.5
      nodes.mR = ctx.createGain(); nodes.mR.gain.value = 0.5
      nodes.sL = ctx.createGain(); nodes.sL.gain.value = 0.5
      nodes.sR = ctx.createGain(); nodes.sR.gain.value = -0.5
      nodes.mid = ctx.createGain(); nodes.mid.gain.value = 1
      nodes.side = ctx.createGain(); nodes.side.gain.value = 1
      nodes.gM = ctx.createGain(); nodes.gM.gain.value = 1
      nodes.gS = ctx.createGain(); nodes.gS.gain.value = 1
      nodes.gSn = ctx.createGain(); nodes.gSn.gain.value = -1

      /* ---- EBU R128 响度标准化增益 + 安全限幅器 ---- */
      nodes.loud = ctx.createGain()
      nodes.loud.gain.value = 1
      nodes.limiter = ctx.createDynamicsCompressor()
      nodes.limiter.threshold.value = 0
      nodes.limiter.knee.value = 0
      nodes.limiter.ratio.value = 1
      nodes.limiter.attack.value = 0.002
      nodes.limiter.release.value = 0.12

      nodes.master = ctx.createGain()
      nodes.master.gain.value = 1

      /* ---------------- 连接 ---------------- */
      nodes.src.connect(nodes.pre)
      var cursor = nodes.pre
      for (var i = 0; i < nodes.eq.length; i++) {
        cursor.connect(nodes.eq[i])
        cursor = nodes.eq[i]
      }
      cursor.connect(nodes.lp1)

      /* 低音支路 */
      nodes.lp1.connect(nodes.lp2)
      nodes.lp2.connect(nodes.lowGain)
      nodes.lowGain.connect(nodes.bandSum)
      /* 谐波激励支路 */
      nodes.lp2.connect(nodes.excDrive)
      nodes.excDrive.connect(nodes.shaper)
      nodes.shaper.connect(nodes.excWet)
      nodes.excWet.connect(nodes.bandSum)
      /* 高频支路（不处理，保持原样） */
      cursor.connect(nodes.hp1)
      nodes.hp1.connect(nodes.hp2)
      nodes.hp2.connect(nodes.bandSum)

      /* 空间感 */
      nodes.bandSum.connect(nodes.ambDry)
      nodes.ambDry.connect(nodes.postAmb)
      if (nodes.conv) {
        nodes.bandSum.connect(nodes.conv)
        nodes.conv.connect(nodes.irWet)
        nodes.irWet.connect(nodes.postAmb)
      }
      nodes.bandSum.connect(nodes.delay)
      nodes.delay.connect(nodes.fb)
      nodes.fb.connect(nodes.delay)
      nodes.delay.connect(nodes.wet)
      nodes.wet.connect(nodes.postAmb)

      /* 宽度 M/S */
      nodes.postAmb.connect(nodes.wSplit)
      nodes.wSplit.connect(nodes.mL, 0)
      nodes.wSplit.connect(nodes.sL, 0)
      nodes.wSplit.connect(nodes.mR, 1)
      nodes.wSplit.connect(nodes.sR, 1)
      nodes.mL.connect(nodes.mid)
      nodes.mR.connect(nodes.mid)
      nodes.sL.connect(nodes.side)
      nodes.sR.connect(nodes.side)
      nodes.mid.connect(nodes.gM)
      nodes.gM.connect(nodes.wMerge, 0, 0)
      nodes.gM.connect(nodes.wMerge, 0, 1)
      nodes.side.connect(nodes.gS)
      nodes.gS.connect(nodes.wMerge, 0, 0)
      nodes.side.connect(nodes.gSn)
      nodes.gSn.connect(nodes.wMerge, 0, 1)

      /* 响度 → 限幅 → 淡入淡出 → 输出 */
      nodes.wMerge.connect(nodes.loud)
      nodes.loud.connect(nodes.limiter)
      nodes.limiter.connect(nodes.master)
      nodes.master.connect(ctx.destination)

      /* ---------------- 测量探针 ---------------- */
      /* 1) 响度：单独 L/R 通道做近 BS.1770 K 加权（高频架 + 38Hz 高通） */
      nodes.lSplit = ctx.createChannelSplitter(2)
      nodes.postAmb.connect(nodes.lSplit)
      var kChain = function (splitter, destIndex) {
        var shelf = ctx.createBiquadFilter()
        shelf.type = 'highshelf'
        shelf.frequency.value = 1681.97
        shelf.gain.value = 4
        var hp = ctx.createBiquadFilter()
        hp.type = 'highpass'
        hp.frequency.value = 38.14
        hp.Q.value = 0.5
        var an = ctx.createAnalyser()
        an.fftSize = 2048
        an.smoothingTimeConstant = 0
        splitter.connect(shelf, destIndex)
        shelf.connect(hp)
        hp.connect(an)
        an.connect(nodes.sink)
        return an
      };
      nodes.aL = kChain(nodes.lSplit, 0)
      nodes.aR = kChain(nodes.lSplit, 1)

      /* 2) 输出：峰值 / 削波 / 电平 / 频谱（挂在 master 之后，反映真实输出） */
      nodes.oSplit = ctx.createChannelSplitter(2)
      nodes.master.connect(nodes.oSplit)
      nodes.aOutL = ctx.createAnalyser()
      nodes.aOutL.fftSize = 2048
      nodes.aOutL.smoothingTimeConstant = 0.5
      nodes.aOutR = ctx.createAnalyser()
      nodes.aOutR.fftSize = 2048
      nodes.aOutR.smoothingTimeConstant = 0
      nodes.oSplit.connect(nodes.aOutL, 0)
      nodes.oSplit.connect(nodes.aOutR, 1)
      nodes.aOutL.connect(nodes.sink)
      nodes.aOutR.connect(nodes.sink)
      nodes.aSpec = ctx.createAnalyser()
      nodes.aSpec.fftSize = 1024
      nodes.aSpec.smoothingTimeConstant = 0.7
      nodes.oSplit.connect(nodes.aSpec, 0)
      nodes.aSpec.connect(nodes.sink)

      /* 3) Mid/Side 能量：用于相关度与宽度相位一致性约束 */
      nodes.aMid = ctx.createAnalyser()
      nodes.aMid.fftSize = 1024
      nodes.mid.connect(nodes.aMid)
      nodes.aMid.connect(nodes.sink)
      nodes.aSide = ctx.createAnalyser()
      nodes.aSide.fftSize = 1024
      nodes.side.connect(nodes.aSide)
      nodes.aSide.connect(nodes.sink)

      /* 4) 直通诊断探针：源信号旁挂一组 K 加权 + 频谱分析器，汇点增益为 0（完全不可闻）。
            这样音效关闭走严格旁路（源直连输出）时，诊断面板依然能读到真实响度/峰值/频谱。 */
      nodes.dSplit = ctx.createChannelSplitter(2)
      nodes.dL = kChain(nodes.dSplit, 0)
      nodes.dR = kChain(nodes.dSplit, 1)
      nodes.dSpec = ctx.createAnalyser()
      nodes.dSpec.fftSize = 1024
      nodes.dSpec.smoothingTimeConstant = 0.7
      nodes.dSplit.connect(nodes.dSpec, 0)
      nodes.dSpec.connect(nodes.sink)

      attached = true
      meter.songStart = 0
      startMetering()
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

  /* ---------------- 实时测量 ---------------- */
  function meanSq(arr) {
    var s = 0
    for (var i = 0; i < arr.length; i++) s += arr[i] * arr[i]
    return arr.length ? s / arr.length : 0
  }

  function lufsOf(ms) {
    if (!(ms > 0)) return NaN
    return -0.691 + 10 * Math.log10(ms)
  }

  function avgMsSince(now, win) {
    var sum = 0
    var n = 0
    for (var i = meter.blocks.length - 1; i >= 0; i--) {
      var b = meter.blocks[i]
      if (now - b.t > win) break
      sum += b.ms
      n++
    }
    return n ? sum / n : 0
  }

  function integratedLufs() {
    var arr = meter.integ
    if (!arr.length) return NaN
    var gated = []
    var sum = 0
    var i
    for (i = 0; i < arr.length; i++) {
      if (arr[i] > -70) { gated.push(arr[i]); sum += arr[i] }
    }
    if (!gated.length) return NaN
    var rel = sum / gated.length - 10
    var sum2 = 0
    var n2 = 0
    for (i = 0; i < gated.length; i++) {
      if (gated[i] > rel) { sum2 += gated[i]; n2++ }
    }
    return n2 ? sum2 / n2 : NaN
  }

  function setLoudGain(v, t) {
    if (!nodes || !nodes.loud) return
    nodes.loud.gain.setTargetAtTime(v, t, 0.12)
  }

  function updateLoudness(t) {
    if (!nodes) return
    if (!cfg.r128) {
      if (meter.gainDb !== 0) { meter.gainDb = 0; setLoudGain(1, t) }
      return
    }
    var lv = meter.sCur
    if (!isFinite(lv)) lv = meter.mCur
    /* 静音 / 极弱段落不做补偿，避免把底噪拉起来 */
    if (!isFinite(lv) || lv < -60) return

    var want = clamp(cfg.r128Target - lv, -15, 12)
    /* 峰值保护：保证输出不超过 -1 dBFS，宁可少补也不削波 */
    if (meter.peak > 0) {
      var cap = -1 - gainToDb(meter.peak)
      if (want > cap) want = cap
    }
    want = clamp(want, -15, 12)

    var step = meter.fast ? 1.0 : 0.22       /* 切歌前 3 秒快跟，之后慢放避免抽吸 */
    if (want > meter.gainDb) meter.gainDb = Math.min(want, meter.gainDb + step)
    else meter.gainDb = Math.max(want, meter.gainDb - step)

    setLoudGain(dbToGain(meter.gainDb), t)
  }

  function widthFactor() {
    /* 相位一致性约束：声道相关度越低（内容越"宽"）越保守，
       反相内容（corr<0）直接不展宽，避免相位抵消造成中空、发闷 */
    var c = clamp(meter.corr, 0, 1)
    return Math.pow(c, 0.6)
  }

  function applyWidth(t) {
    if (!nodes) return
    var w = cfg.enabled ? clamp(cfg.width, 0, 1) : 0
    var factor = widthFactor()
    var gS = 1 + w * 1.6 * factor
    var norm = 1 / (1 + 0.35 * w)          /* 展宽后整体电平均有上升，做静态补偿 */
    nodes.gS.gain.setTargetAtTime(gS, t, 0.06)
    nodes.gSn.gain.setTargetAtTime(-gS, t, 0.06)
    nodes.gM.gain.setTargetAtTime(norm, t, 0.06)
    meter.gainS = gS
    meter.widthFactor = factor
  }

  function tick() {
    if (!nodes || !ctx) return
    var now = (window.performance && window.performance.now) ? window.performance.now() : Date.now()
    if (!meter.songStart) meter.songStart = now
    var running = ctx.state === 'running'

    if (running) {
      /* 旁路时读取直通探针，开启时读取处理链末端，保证面板始终反映真实听到的信号 */
      var pL = bypassed ? nodes.dL : nodes.aL
      var pR = bypassed ? nodes.dR : nodes.aR
      var bL = bypassed ? nodes.dL : nodes.aOutL
      var bR = bypassed ? nodes.dR : nodes.aOutR

      /* 响度（K 加权后 L/R 分别取均方，再相加） */
      if (pL && pR) {
        if (!meter.bufL || meter.bufL.length !== pL.fftSize) {
          meter.bufL = new Float32Array(pL.fftSize)
          meter.bufR = new Float32Array(pR.fftSize)
        }
        pL.getFloatTimeDomainData(meter.bufL)
        pR.getFloatTimeDomainData(meter.bufR)
        meter.mL = meanSq(meter.bufL)
        meter.mR = meanSq(meter.bufR)
        meter.blocks.push({ t: now, ms: meter.mL + meter.mR })
        while (meter.blocks.length && now - meter.blocks[0].t > 3200) meter.blocks.shift()
        meter.mCur = lufsOf(avgMsSince(now, 420))
        meter.sCur = lufsOf(avgMsSince(now, 3000))
        if (now - meter.lastIntegPush > 380 && isFinite(meter.mCur)) {
          meter.lastIntegPush = now
          meter.integ.push(meter.mCur)
          if (meter.integ.length > 20000) meter.integ.shift()
          meter.iCur = integratedLufs()
        }
      }

      /* 输出峰值 / 削波 / 电平 */
      if (bL && bR) {
        if (!meter.bufOL || meter.bufOL.length !== bL.fftSize) {
          meter.bufOL = new Float32Array(bL.fftSize)
          meter.bufOR = new Float32Array(bR.fftSize)
        }
        bL.getFloatTimeDomainData(meter.bufOL)
        bR.getFloatTimeDomainData(meter.bufOR)
        var peak = 0
        var clip = 0
        for (var i = 0; i < meter.bufOL.length; i++) {
          var a = meter.bufOL[i] < 0 ? -meter.bufOL[i] : meter.bufOL[i]
          if (a > peak) peak = a
          if (a >= 0.999) clip++
        }
        for (var j = 0; j < meter.bufOR.length; j++) {
          var b = meter.bufOR[j] < 0 ? -meter.bufOR[j] : meter.bufOR[j]
          if (b > peak) peak = b
          if (b >= 0.999) clip++
        }
        meter.peak = peak
        meter.peakHold = Math.max(peak, meter.peakHold * 0.9)
        meter.clip += clip
        meter.rmsL = Math.sqrt(meanSq(meter.bufOL))
        meter.rmsR = Math.sqrt(meanSq(meter.bufOR))
      }

      /* 声道相关度 = (Em - Es) / (Em + Es) */
      if (nodes.aMid && nodes.aSide) {
        if (!meter.bufMid) {
          meter.bufMid = new Float32Array(nodes.aMid.fftSize)
          meter.bufSide = new Float32Array(nodes.aSide.fftSize)
        }
        nodes.aMid.getFloatTimeDomainData(meter.bufMid)
        nodes.aSide.getFloatTimeDomainData(meter.bufSide)
        var em = meanSq(meter.bufMid)
        var es = meanSq(meter.bufSide)
        if (em + es > 1e-9) {
          var c = (em - es) / (em + es)
          meter.corr = meter.corr * 0.75 + clamp(c, -1, 1) * 0.25
        }
      }

      if (cfg.enabled) {
        meter.fast = (now - meter.songStart) < 3000
        updateLoudness(ctx.currentTime)
        if (cfg.width > 0) applyWidth(ctx.currentTime)
      }
    }
  }

  function startMetering() {
    if (meter.timer) return
    meter.timer = setInterval(tick, 100)
    if (meter.timer && typeof meter.timer.unref === 'function') meter.timer.unref()
  }

  function resetMeter() {
    meter.blocks = []
    meter.integ = []
    meter.lastIntegPush = 0
    meter.songStart = 0
    meter.fast = true
    meter.mCur = NaN
    meter.sCur = NaN
    meter.iCur = NaN
    meter.peak = 0
    meter.peakHold = 0
    meter.clip = 0
    meter.corr = 1
    meter.gainDb = 0
    meter.gainS = 1
    meter.widthFactor = 1
    if (nodes && nodes.loud && ctx) nodes.loud.gain.setTargetAtTime(1, ctx.currentTime, 0.05)
  }

  /* ---------------- 参数下发 ---------------- */
  /* 音效关闭时真正的旁路：源节点直连输出，不再经过整条处理链（零着色、零延迟） */
  function setRoute(bypass) {
    if (!nodes || !ctx) return
    if (bypass === bypassed) return
    try { nodes.src.disconnect() } catch (e) {}
    try {
      /* 诊断支路常接（经 0 增益汇点，不出声），保证旁路时仍有真实测量 */
      if (nodes.dSplit) nodes.src.connect(nodes.dSplit)
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
        nodes.eq[i].gain.setTargetAtTime(clamp(eq[i] || 0, -12, 12), t, 0.02)
      }

      /* 分频低音 + 谐波激励 */
      var bassDb = on ? clamp(cfg.bass, 0, 1) * MAX_BASS_DB : 0
      nodes.lowGain.gain.setTargetAtTime(dbToGain(bassDb), t, 0.03)
      var ex = on ? clamp(cfg.exciter, 0, 1) : 0
      nodes.excDrive.gain.setTargetAtTime(1 + ex * 3, t, 0.03)
      nodes.excWet.gain.setTargetAtTime(ex * 0.5, t, 0.03)

      /* 空间感 */
      var preset = PRESETS[cfg.preset] || PRESETS.original
      var amb = on ? clamp(preset.ambience || 0, 0, 1) : 0
      var mode = on ? (cfg.ambienceMode || 'ir') : 'off'
      if (mode === 'ir' && amb > 0) ensureIR()
      var irOk = mode === 'ir' && !!nodes.conv && !!nodes.conv.buffer && !!nodes.irWet
      var legacy = mode === 'legacy'
      if (nodes.irWet) nodes.irWet.gain.setTargetAtTime(irOk ? amb * 0.55 : 0, t, 0.06)
      nodes.wet.gain.setTargetAtTime(legacy ? amb * 0.45 : 0, t, 0.06)
      nodes.fb.gain.setTargetAtTime(legacy ? amb * 0.2 : 0, t, 0.06)
      nodes.ambDry.gain.setTargetAtTime(1, t, 0.03)

      /* 宽度矩阵 */
      applyWidth(t)

      /* 响度标准化：开时启用安全限幅；关时增益归 1、限幅器透明 */
      if (on && cfg.r128) {
        nodes.limiter.threshold.setTargetAtTime(-1.5, t, 0.05)
        nodes.limiter.knee.setTargetAtTime(0, t, 0.05)
        nodes.limiter.ratio.setTargetAtTime(20, t, 0.05)
        nodes.limiter.attack.setTargetAtTime(0.002, t, 0.05)
        nodes.limiter.release.setTargetAtTime(0.12, t, 0.05)
      } else {
        meter.gainDb = 0
        setLoudGain(1, t)
        nodes.limiter.threshold.setTargetAtTime(0, t, 0.05)
        nodes.limiter.knee.setTargetAtTime(0, t, 0.05)
        nodes.limiter.ratio.setTargetAtTime(1, t, 0.05)
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
    AMB_MODES: AMB_MODES,
    R128_TARGETS: R128_TARGETS,

    /** 载入持久化配置（不建链，避免未开音效时被 AudioContext 挂起影响出声） */
    load: function (saved) {
      if (saved && typeof saved === 'object') {
        cfg.enabled = !!saved.enabled
        cfg.preset = saved.preset || 'original'
        cfg.eq = (Array.isArray(saved.eq) && saved.eq.length === 10 ? saved.eq : cfg.eq).map(function (v) { return clamp(v, -12, 12) })
        cfg.width = clamp(saved.width || 0, 0, 1)
        cfg.bass = clamp(saved.bass || 0, 0, 1)
        cfg.exciter = clamp(saved.exciter || 0, 0, 1)
        cfg.r128 = saved.r128 === undefined ? !!saved.smartVolume : !!saved.r128
        cfg.r128Target = clamp(saved.r128Target === undefined ? -14 : saved.r128Target, -23, -6)
        var am = String(saved.ambienceMode || 'ir')
        cfg.ambienceMode = am === 'legacy' || am === 'off' ? am : 'ir'
        cfg.smartVolume = !!cfg.r128
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
      if (!attached && (force || cfg.enabled)) { build() }
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
      cfg.r128 = p.comp === undefined ? cfg.r128 : !!p.comp
      cfg.smartVolume = !!cfg.r128
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

    /** 谐波激励强度 0~1 */
    setExciter: function (v) { cfg.exciter = clamp(v, 0, 1); apply(); persist() },

    /** EBU R128 响度标准化开关 */
    setR128: function (b) {
      cfg.r128 = !!b
      cfg.smartVolume = cfg.r128
      apply()
      persist()
      return cfg.r128
    },

    /** 目标响度（LUFS），限 -23~-6 */
    setR128Target: function (v) {
      cfg.r128Target = clamp(v, -23, -6)
      if (!cfg.r128) cfg.r128 = true
      cfg.smartVolume = cfg.r128
      apply()
      persist()
      return cfg.r128Target
    },

    /** 空间感实现方式：'ir' 卷积 / 'legacy' 经典延迟 / 'off' 关闭 */
    setAmbienceMode: function (k) {
      k = String(k || 'ir')
      cfg.ambienceMode = k === 'legacy' || k === 'off' ? k : 'ir'
      apply()
      persist()
      return cfg.ambienceMode
    },

    /* 兼容旧接口：智能音量 = 响度标准化 */
    setSmartVolume: function (b) { return AudioFX.setR128(b) },

    setFade: function (s) { cfg.fade = clamp(s, 0, 5); persist() },
    setRate: function (r) { cfg.rate = clamp(r, 0.5, 2); apply(); persist() },

    /** 当前是否为"纯原声"（无任何音效着色） */
    isNeutral: function () {
      if (!cfg.enabled) return true
      var p = PRESETS[cfg.preset]
      if (!p && !cfg.customPresets[cfg.preset]) {
        return cfg.eq.every(function (v) { return v === 0 }) && cfg.bass === 0 && cfg.width === 0 && cfg.exciter === 0
      }
      return cfg.preset === 'original' && cfg.bass === 0 && cfg.width === 0 && cfg.exciter === 0
    },

    /** 保存当前 EQ/低音/宽度/激励为自定义预设 */
    savePreset: function (name) {
      name = String(name || '').trim()
      if (!name) return false
      cfg.customPresets[name] = {
        name: name,
        eq: cfg.eq.slice(),
        bass: cfg.bass,
        width: cfg.width,
        exciter: cfg.exciter,
        comp: cfg.r128,
        custom: true,
      }
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

    /** 记录当前音频流的实测编码信息（来自服务端探针），供诊断面板展示 */
    setStreamInfo: function (info) {
      streamInfo = info ? {
        codec: info.codec || '',
        bitsPerSample: info.bitsPerSample || 0,
        sampleRate: info.sampleRate || 0,
        channels: info.channels || 0,
        quality: info.quality || '',
        sizeText: info.sizeText || '',
        api: info.api || '',
        local: !!info.local,
        path: info.path || '',
      } : null
      resetMeter()
      return streamInfo
    },

    /** 诊断快照：编码 / 响度 / 峰值 / 削波 / 相关度 / 各增强项状态 */
    diag: function () {
      var s = streamInfo || {}
      return {
        ready: !!(attached && ctx && ctx.state === 'running'),
        ctx: ctx ? ctx.state : 'none',
        enabled: !!cfg.enabled,
        bypassed: bypassed,
        ctxRate: ctx ? ctx.sampleRate : 0,
        stream: {
          codec: s.codec || '',
          bitsPerSample: s.bitsPerSample || 0,
          sampleRate: s.sampleRate || 0,
          channels: s.channels || 0,
          quality: s.quality || '',
          sizeText: s.sizeText || '',
          api: s.api || '',
          local: !!s.local,
        },
        loud: {
          m: meter.mCur,
          s: meter.sCur,
          i: meter.iCur,
          target: cfg.r128Target,
          gainDb: cfg.r128 ? meter.gainDb : 0,
          on: !!cfg.r128,
        },
        peak: {
          db: gainToDb(meter.peak),
          holdDb: gainToDb(meter.peakHold),
          clip: meter.clip,
          clipping: meter.peak >= 0.999,
        },
        level: {
          l: gainToDb(meter.rmsL),
          r: gainToDb(meter.rmsR),
        },
        corr: meter.corr,
        width: { cfg: cfg.width, applied: meter.gainS, factor: meter.widthFactor },
        bass: cfg.bass,
        exciter: cfg.exciter,
        ambience: cfg.ambienceMode,
        ambienceOn: !!cfg.enabled && (cfg.ambienceMode !== 'off'),
        r128: !!cfg.r128,
        target: cfg.r128Target,
      }
    },

    /** 输出频谱（对数分带，供诊断面板画柱状图） */
    spectrum: function (bands) {
      bands = bands || 40
      var out = []
      for (var i = 0; i < bands; i++) out.push(0)
      if (!nodes || !ctx || ctx.state !== 'running') return out
      var an = bypassed ? nodes.dSpec : nodes.aSpec
      if (!an) return out
      var bins = an.frequencyBinCount
      if (!meter.spec || meter.spec.length !== bins) meter.spec = new Uint8Array(bins)
      an.getByteFrequencyData(meter.spec)
      var nyq = ctx.sampleRate / 2
      for (var b = 0; b < bands; b++) {
        var f0 = 30 * Math.pow(nyq / 30, b / bands)
        var f1 = 30 * Math.pow(nyq / 30, (b + 1) / bands)
        var i0 = Math.max(0, Math.floor((f0 / nyq) * bins))
        var i1 = Math.min(bins - 1, Math.max(i0, Math.floor((f1 / nyq) * bins)))
        var max = 0
        for (var k = i0; k <= i1; k++) if (meter.spec[k] > max) max = meter.spec[k]
        out[b] = max / 255
      }
      return out
    },

    /** 实时输出探针（兼容 v1 接口） */
    tap: function () {
      if (!nodes || !ctx) return null
      return nodes.aSpec || null
    },
    isBypassed: function () { return bypassed },
    reapply: apply,
    isReady: function () { return attached && !!ctx && ctx.state === 'running' },
    ctxState: function () { return ctx ? ctx.state : 'none' },
    resume: resume,
    resetMeter: resetMeter,
  }

  window.AudioFX = AudioFX
})()
