/* ===========================================================
   音效引擎 v2（Web Audio API，对齐 QQ音乐 的音效能力 + 开源音质增强）
   -----------------------------------------------------------
   信号链（v59 修复刺啦失真）：
     <audio> → MediaElementSource → preGain（自动 headroom 预衰减）
             → 10 段 EQ(31/62/125/250/500/1k/2k/4k/8k/16k)
             → 分频低音（Linkwitz-Riley 4 阶 @160Hz）
                  ├ low  → lowGain(0~+9dB) ──────────────┐
                  └ low  → 30Hz 高通 → tanh 激励(≤1.8x) ──┤
                    high → ─────────────────────────────┤
                                                        ↓
                                     空间感（IR-RMS 归一 卷积 / 经典延迟 / 关闭）
                                                        ↓
                              立体声宽度（真 M/S 增益 + mid 补偿 + 相位一致性约束）
                                                        ↓
                              EBU R128 响度标准化（可选动态增益）
                                                        ↓
             母带总线 Mastering Bus（v60 新增，可开关，关闭时纯增益直通）
                 30Hz 高通 → 胶水压缩(-12~-24dB/1.5~4:1) → 轻度 makeup
                 → 存在感架(2.5~4kHz) → 空气架(12kHz)
                 → M/S：侧路 120Hz 高通（低频单声道化）+ 展宽 ≤+8% + mid 补偿
                 → 并联 tanh 饱和（干湿混音，unit-slope 曲线）
                                                        ↓
                    常开三级限幅：4ms 前视 → 压缩(-2.5dB/20:1) → 真峰值软钳(-1dBFS, 4x)
                                                        ↓
                                       master(淡入淡出) → 输出

   v59 修的四个失真根因：
   1) 激励器旧曲线覆盖 [-1,1]，而 drive 最高 4 倍，超域输入被夹成曲线端点平顶
      → 硬拐角（"刺啦"主因）。现改 tanh(k·x)/tanh(k) 全域连续可导，drive ≤1.8，
      湿声 ≤0.35，输入端加 30Hz 高通避免直流偏移把曲线推偏；
   2) 全链无 headroom：EQ(+12dB)/低音(+9dB)/宽侧路同时提升必然超 0dBFS。
      现按最大提升量算出总 headroom，在 preGain 上整体预衰减；
   3) 限幅器形同虚设（只有 R128 开着才生效，否则 ratio=1 纯直通、末端无钳位）。
      现三级常开，-1dBFS 是硬上限；
   4) 程序化 IR 按峰值归一，卷积湿声局部过载。现按能量(RMS)归一，湿声 ≤0.35。

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
    /* 无损直通：完整旁路，源节点直连输出（零处理、零着色、零延迟），
       语义等价于"关闭音效"，但作为预设可直接点选，用于 A/B 对照 */
    lossless:     { name: '无损直通',    eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],              bass: 0,    width: 0,    ambience: 0,    comp: false, bypass: true },
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

  /* ---- v59 音质参数 ---- */
  var CTX_RATE = 48000     /* 固定 48k 上下文，避免 iOS 从 44.1k 反复重采样抖动 */
  var EXC_HP = 30          /* 激励器前级高通：切掉直流与次声，避免曲线偏置 */
  var EXC_MAX_DRIVE = 1.8  /* 激励器最大驱动倍数（旧版 4 倍是刺啦主因） */
  var EXC_MAX_WET = 0.35   /* 激励湿声上限 */
  var MAX_IR_WET = 0.35    /* 卷积湿声上限 */
  var LOOKAHEAD = 0.004    /* 限幅前视 4ms */
  var LIMIT_THRESHOLD = -2.5
  var CLIP_KNEE = 0.85     /* 软钳线性区顶 */
  var CLIP_CEIL = 0.891    /* 软钳上限 = -1dBFS */
  var HEADROOM_MAX_DB = 10

  /* ---- v60 母带总线（Mastering Bus）参数 ----
     设计口径参照在线母带服务（LoopMastering）的几个可感知维度：低频收紧、胶水粘合、
     存在感、空气感、密度饱和、立体声宽度、真峰值收口。全部用 Web Audio 原生节点拼装，
     零依赖、零素材，不做离线渲染，处理延迟仅限限幅前视 4ms（母带本身无附加延迟）。 */
  var MB_HP = 30              /* 母带入口高通：切次声，避免压缩器被 20Hz 以下能量带偏 */
  var MB_MONO_HZ = 120        /* 侧路 120Hz 高通 = 120Hz 以下侧信号衰减，低频单声道化 */
  var MB_AIR_FREQ = 12000     /* 空气感高架点：12kHz 以上"嘶"感，纯空气不刺耳 */
  var MB_MAX_PRESENCE_DB = 1.5
  var MB_MAX_AIR_DB = 3.0
  var MB_MAX_SAT_WET = 0.30   /* 并联饱和湿声上限 */
  var MB_MAX_WIDTH = 0.08     /* 母带 M/S 展宽上限 +8% */
  var MB_GLUE_ATK = 0.03
  var MB_GLUE_REL = 0.25

  /* 母带风格预设：glue/sat/air/width 为 0~1 归一量，presence 为 dB、presenceFreq 为架点 */
  var MASTER_PRESETS = {
    clear: { name: '清晰', glue: 0.45, sat: 0.50, air: 0.66, width: 0.60, presence: 1.2, presenceFreq: 3200, makeup: 0.6 },
    warm:  { name: '温暖', glue: 0.55, sat: 0.80, air: 0.40, width: 0.40, presence: 0.8, presenceFreq: 2500, makeup: 1.2 },
    punch: { name: '冲击', glue: 0.50, sat: 0.45, air: 0.46, width: 0.50, presence: 1.5, presenceFreq: 3500, makeup: 1.4 },
    loud:  { name: '响度', glue: 0.85, sat: 0.85, air: 0.83, width: 1.00, presence: 1.0, presenceFreq: 3000, makeup: 2.4 },
  }

  /* v62：母带总线改为默认开启（默认风格仍为 clear，着色极轻：低频单声道化 + 少量空气感）。
     旧版本（v60/v61）母带默认关闭，升级时必须按"有没有人工修改痕迹"决定是否沿用新默认：
       · userSet === true            —— 用户在 UI 里手动开关过母带，完全尊重其选择
       · 老配置无 userSet 但有痕迹    —— 视为人工选择（开过、换过风格、动过滑杆），保留其 on 值
       · 老配置无 userSet 且无痕迹    —— 迁移到新默认（开启），这是本次改版的主目标 */
  var MASTER_DEFAULT_ON = true
  var AUDIOFX_CFG_VER = 2

  var cfg = {
    /* v62：音效链默认开启，否则母带默认开启在"音效链没建"的情况下也不会生效 */
    enabled: MASTER_DEFAULT_ON,
    cfgVer: AUDIOFX_CFG_VER,
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
    /* v60 母带总线：on 开关 + 风格预设 + 四个归一量参数（0~1）；v62 起默认开启 */
    mastering: {
      on: MASTER_DEFAULT_ON,
      userSet: false,
      preset: 'clear',
      glue: MASTER_PRESETS.clear.glue,
      sat: MASTER_PRESETS.clear.sat,
      air: MASTER_PRESETS.clear.air,
      width: MASTER_PRESETS.clear.width,
    },
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
    headroomDb: 0,
    limReduction: 0,
    limActive: false,
    /* v60 母带总线实时读数 */
    mbApplied: false,
    mbGr: 0,
    mbActive: false,
    mbGlue: 0,
    mbSat: 0,
    mbAirDb: 0,
    mbPresenceDb: 0,
    mbMakeupDb: 0,
    mbWidth: 0,
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
      cfgVer: AUDIOFX_CFG_VER,
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
      mastering: {
        on: !!cfg.mastering.on,
        userSet: !!cfg.mastering.userSet,
        preset: cfg.mastering.preset,
        glue: cfg.mastering.glue,
        sat: cfg.mastering.sat,
        air: cfg.mastering.air,
        width: cfg.mastering.width,
      },
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

    /* v59：按能量（RMS）归一化，而不是按峰值。
       令 sqrt(Σ h²) = 1，则卷积对宽带素材的能量增益恰为 0dB，
       湿声大小完全由 irWet 控制；旧版峰值归一在 1.2s 尾巴上会让湿声局部抬高
       数倍，叠上 amb*0.55 直接过载（"糊 + 刺"的次要来源）。 */
    var energy = 0
    for (var c2 = 0; c2 < 2; c2++) {
      var data = buf.getChannelData(c2)
      for (var j = 0; j < data.length; j++) energy += data[j] * data[j]
    }
    if (energy > 1e-12 && isFinite(energy)) {
      var g = 1 / Math.sqrt(energy)
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

  /* 谐波激励曲线：y = tanh(k·x) / tanh(k)
     —— 全域连续可导，端点严格落在 ±1，输入再大也不会被夹成平顶；
     旧版 ((1+k)x)/(1+k|x|) 在端点附近导数趋 0 但配合 4 倍 drive 仍会撞到端点，
     现在驱动上限 1.8，配合前级 30Hz 高通，不再有硬拐角失真。 */
  function makeExciterCurve(k) {
    k = k > 0 ? k : 3
    var n = 2048
    var curve = new Float32Array(n)
    var denom = Math.tanh(k)
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1
      curve[i] = Math.tanh(k * x) / denom
    }
    return curve
  }

  /* 母带并联饱和曲线：y = tanh(k·x) / k
     —— 与激励器曲线的关键差别是"单位斜率"：x→0 时 y'≈1，即小信号经过曲线后
     电平不变（激励器用 tanh(k·x)/tanh(k) 是"满量程归一"，小信号会被放大 k 倍，
     并联混进主路会直接抬高响度、把低电平细节顶出来）。这里小信号透明，
     只有峰值部分被 tanh 压弯产生偶次/奇次谐波，并联混音后是"加密度不加音量"。
     k 固定 3：k 越大谐波越多但越容易在高频产生毛刺，3 是听感与干净度的折中。 */
  function makeSatCurve(k) {
    var n = 4096
    var curve = new Float32Array(n)
    var kk = k > 0 ? k : 3
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1
      curve[i] = Math.tanh(kk * x) / kk
    }
    return curve
  }

  /* 母带风格预设与参数映射：把 0~1 的归一量换成具体 dB / 比例 */
  function masterPreset() {
    return MASTER_PRESETS[cfg.mastering.preset] || MASTER_PRESETS.clear
  }
  /* 胶水压缩：glue 0→阈值 -12dB/1.5:1（几乎不压），1→-24dB/4:1（明显粘合） */
  function masterGlueThreshold(g) { return -12 - 12 * clamp(g, 0, 1) }
  function masterGlueRatio(g) { return 1.5 + 2.5 * clamp(g, 0, 1) }
  /* 胶水压缩当前衰减量：优先读节点实时值（旧 WebView 不暴露 reduction 时退回 tick 里缓存的读数） */
  function masterGrDb() {
    if (!meter.mbApplied) return 0
    if (nodes && nodes.mbGlue && typeof nodes.mbGlue.reduction === 'number') return nodes.mbGlue.reduction
    return meter.mbGr || 0
  }

  /* 末端真峰值软钳曲线：
     |x| ≤ 0.85 → 完全线性（不动细节，不做染色）；
     0.85 → 0.932 → 用抛物线平滑收口到 0.891（-1dBFS），在 0.85 处斜率同为 1、
     在 0.932 处斜率降为 0，一阶导连续，因此没有任何硬拐角；
     |x| > 0.932 → 恒为 0.891，作为整条链的硬上限（配 4x 过采样压掉采样间峰值）。 */
  function makeClipCurve() {
    var n = 4096
    var curve = new Float32Array(n)
    var d = CLIP_CEIL - CLIP_KNEE
    var top = CLIP_KNEE + 2 * d
    var kk = 1 / (4 * d)
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1
      var a = x < 0 ? -x : x
      var y
      if (a <= CLIP_KNEE) y = a
      else if (a < top) y = CLIP_CEIL - kk * (a - top) * (a - top)
      else y = CLIP_CEIL
      curve[i] = x < 0 ? -y : y
    }
    return curve
  }

  /* ---------------- 建链（一次性） ---------------- */
  function build() {
    if (attached || !audioEl) return attached
    var AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return false
    try {
      /* 固定 48k + playback 延迟策略：iOS 端 <audio> 常见 44.1k 素材，
         统一在 48k 上下文里重采样，避免播放中被系统按输出设备来回切采样率
         造成周期性抖动（听感上是轻微的"毛刺"）；老 WebView 不接受参数时回退默认。 */
      try {
        ctx = new AC({ sampleRate: CTX_RATE, latencyHint: 'playback' })
      } catch (e1) {
        ctx = new AC()
      }
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

      /* 谐波激励：低音支路并联一路软饱和，产生二次/三次谐波补偿低频感知
         v59：输入端串 30Hz 高通（去直流/次声，避免把 tanh 曲线推偏），
         drive 上限 1.8，湿声上限 0.35 */
      nodes.excHP = ctx.createBiquadFilter()
      nodes.excHP.type = 'highpass'
      nodes.excHP.frequency.value = EXC_HP
      nodes.excHP.Q.value = 0.7071
      nodes.excDrive = ctx.createGain()
      nodes.excDrive.gain.value = 1
      nodes.shaper = ctx.createWaveShaper()
      nodes.shaper.curve = makeExciterCurve(3)
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

      /* ---- EBU R128 响度标准化增益 + 常开三级限幅 ----
         ① laDelay：4ms 前视，让后级的衰减在峰值到达之前就位（lookahead 思路，
            参考 @synthlet/lookahead-limiter 的前视砖墙结构，但零依赖自实现）；
         ② comp：-2.5dB / 20:1 / knee 0 / attack 1ms / release 150ms，慢速压住持续大信号，
            不做 makeup 增益，因此它是"只降不升"；
         ③ clip：真峰值软钳，|x|≤0.85 线性，平滑收口到 0.891(-1dBFS)，4x 过采样，
            作为整条链的硬上限（旧版这里什么也没有，削波直接送到扬声器）。 */
      nodes.loud = ctx.createGain()
      nodes.loud.gain.value = 1

      nodes.laDelay = ctx.createDelay(0.05)
      nodes.laDelay.delayTime.value = LOOKAHEAD

      nodes.comp = ctx.createDynamicsCompressor()
      nodes.comp.threshold.value = LIMIT_THRESHOLD
      nodes.comp.knee.value = 0
      nodes.comp.ratio.value = 20
      nodes.comp.attack.value = 0.001
      nodes.comp.release.value = 0.15

      nodes.clip = ctx.createWaveShaper()
      nodes.clip.curve = makeClipCurve()
      nodes.clip.oversample = '4x'

      /* ---- v60 母带总线（Mastering Bus）----
         位置：R128 响度之后、末级限幅之前（母带是"最后一公里"的着色与响度整合，
         必须让限幅器看到母带增益，才能保证 -1dBFS 硬上限不被冲破）。
         关闭时 mbDry=1 / mbWet=0：信号只是一个增益为 1 的 GainNode，零着色零附加延迟；
         开启时 mbDry=0 / mbWet=1：信号走完整母带链。两者都汇入 laDelay，切换用
         30ms setTargetAtTime 交叉淡化，不会爆音也不会中断播放。 */
      nodes.mbDry = ctx.createGain(); nodes.mbDry.gain.value = 1
      nodes.mbWet = ctx.createGain(); nodes.mbWet.gain.value = 0
      nodes.mbIn = ctx.createGain(); nodes.mbIn.gain.value = 1
      nodes.mbOut = ctx.createGain(); nodes.mbOut.gain.value = 1

      /* ① 低频收紧之一：入口 30Hz 二阶高通，先把次声/直流切掉，
            否则低频能量会把胶水压缩器带偏（一压全曲，中高频跟着抽） */
      nodes.mbHp = ctx.createBiquadFilter()
      nodes.mbHp.type = 'highpass'
      nodes.mbHp.frequency.value = MB_HP
      nodes.mbHp.Q.value = 0.7071

      /* ② 总线胶水压缩：慢 attack（30ms，放过瞬态保住"冲击"）+ 中慢 release（250ms，
            让总线轻微"呼吸"粘在一起），knee 6dB 软拐点，不做激进限幅 */
      nodes.mbGlue = ctx.createDynamicsCompressor()
      nodes.mbGlue.threshold.value = masterGlueThreshold(cfg.mastering.glue)
      nodes.mbGlue.knee.value = 6
      nodes.mbGlue.ratio.value = masterGlueRatio(cfg.mastering.glue)
      nodes.mbGlue.attack.value = MB_GLUE_ATK
      nodes.mbGlue.release.value = MB_GLUE_REL

      nodes.mbMakeup = ctx.createGain()
      nodes.mbMakeup.gain.value = 1

      /* ③ 存在感（2.5~4kHz 高架，抓咬字与鼓皮）+ 空气感（12kHz 宽 Q 高架，
            纯"空气"不刺耳）。都用 highshelf，相位特性温和，不会像 peaking 堆高 Q 那样
            在瞬态上产生"啾"声 */
      nodes.mbPresence = ctx.createBiquadFilter()
      nodes.mbPresence.type = 'highshelf'
      nodes.mbPresence.frequency.value = masterPreset().presenceFreq
      nodes.mbPresence.gain.value = 0

      nodes.mbAir = ctx.createBiquadFilter()
      nodes.mbAir.type = 'highshelf'
      nodes.mbAir.frequency.value = MB_AIR_FREQ
      nodes.mbAir.Q.value = 0.6
      nodes.mbAir.gain.value = 0

      /* ④ M/S：侧路 120Hz 高通 = 低频单声道化（底鼓/贝斯更实、能量集中）；
            展宽只动侧路，mid 同步补偿，保证重建后峰值不随宽度上升（不与前面
            的宽度模块叠加出相位抵消）。宽度按相关度收缩，反相内容不展宽。 */
      nodes.mbSplit = ctx.createChannelSplitter(2)
      nodes.mbMerge = ctx.createChannelMerger(2)
      nodes.mbMidL = ctx.createGain(); nodes.mbMidL.gain.value = 0.5
      nodes.mbMidR = ctx.createGain(); nodes.mbMidR.gain.value = 0.5
      nodes.mbSideL = ctx.createGain(); nodes.mbSideL.gain.value = 0.5
      nodes.mbSideR = ctx.createGain(); nodes.mbSideR.gain.value = -0.5
      nodes.mbMidSum = ctx.createGain(); nodes.mbMidSum.gain.value = 1
      nodes.mbSideSum = ctx.createGain(); nodes.mbSideSum.gain.value = 1
      nodes.mbSideHp = ctx.createBiquadFilter()
      nodes.mbSideHp.type = 'highpass'
      nodes.mbSideHp.frequency.value = MB_MONO_HZ
      nodes.mbSideHp.Q.value = 0.7071
      nodes.mbMidG = ctx.createGain(); nodes.mbMidG.gain.value = 1
      nodes.mbSideG = ctx.createGain(); nodes.mbSideG.gain.value = 1
      nodes.mbSideNeg = ctx.createGain(); nodes.mbSideNeg.gain.value = -1

      /* ⑤ 并联谐波饱和：干声直通 + 湿声经 unit-slope tanh（4x 过采样防混叠），
            wet=0 时与"未加饱和"完全等价，因此开关与滑杆都不会改变基础音色 */
      nodes.mbSatDrive = ctx.createGain(); nodes.mbSatDrive.gain.value = 1
      nodes.mbSatShape = ctx.createWaveShaper()
      nodes.mbSatShape.curve = makeSatCurve(3)
      nodes.mbSatShape.oversample = '4x'
      nodes.mbSatWet = ctx.createGain(); nodes.mbSatWet.gain.value = 0

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
      /* 谐波激励支路（先 30Hz 高通，再进 tanh 曲线） */
      nodes.lp2.connect(nodes.excHP)
      nodes.excHP.connect(nodes.excDrive)
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

      /* 响度 → 母带总线 → 前视 → 压缩 → 真峰值软钳 → 淡入淡出 → 输出 */
      nodes.wMerge.connect(nodes.loud)

      /* 母带关闭：loud → mbDry(1) → laDelay（纯增益节点，零着色）
         母带开启：loud → mbIn → 母带链 → mbOut → mbWet(1) → laDelay */
      nodes.loud.connect(nodes.mbDry)
      nodes.mbDry.connect(nodes.laDelay)
      nodes.loud.connect(nodes.mbIn)
      nodes.mbIn.connect(nodes.mbHp)
      nodes.mbHp.connect(nodes.mbGlue)
      nodes.mbGlue.connect(nodes.mbMakeup)
      nodes.mbMakeup.connect(nodes.mbPresence)
      nodes.mbPresence.connect(nodes.mbAir)
      nodes.mbAir.connect(nodes.mbSplit)
      nodes.mbSplit.connect(nodes.mbMidL, 0)
      nodes.mbSplit.connect(nodes.mbSideL, 0)
      nodes.mbSplit.connect(nodes.mbMidR, 1)
      nodes.mbSplit.connect(nodes.mbSideR, 1)
      nodes.mbMidL.connect(nodes.mbMidSum)
      nodes.mbMidR.connect(nodes.mbMidSum)
      nodes.mbSideL.connect(nodes.mbSideSum)
      nodes.mbSideR.connect(nodes.mbSideSum)
      /* 侧路只走 120Hz 高通后的信号：120Hz 以下的侧信息被丢弃 = 低频单声道化 */
      nodes.mbSideSum.connect(nodes.mbSideHp)
      nodes.mbSideHp.connect(nodes.mbSideG)
      nodes.mbMidSum.connect(nodes.mbMidG)
      nodes.mbSideG.connect(nodes.mbMerge, 0, 0)
      nodes.mbSideG.connect(nodes.mbSideNeg)
      nodes.mbSideNeg.connect(nodes.mbMerge, 0, 1)
      nodes.mbMidG.connect(nodes.mbMerge, 0, 0)
      nodes.mbMidG.connect(nodes.mbMerge, 0, 1)
      nodes.mbMerge.connect(nodes.mbOut)
      nodes.mbMerge.connect(nodes.mbSatDrive)
      nodes.mbSatDrive.connect(nodes.mbSatShape)
      nodes.mbSatShape.connect(nodes.mbSatWet)
      nodes.mbSatWet.connect(nodes.mbOut)
      nodes.mbOut.connect(nodes.mbWet)
      nodes.mbWet.connect(nodes.laDelay)

      nodes.laDelay.connect(nodes.comp)
      nodes.comp.connect(nodes.clip)
      nodes.clip.connect(nodes.master)
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
      /* v62：默认开链后 AudioContext 可能因自动播放策略仍是 suspended，
         等它真正进入 running 时再下发一次参数，避免"面板已开但实际没生效"。 */
      try {
        ctx.onstatechange = function () {
          if (ctx && ctx.state === 'running') {
            try { apply() } catch (e) {}
          }
        }
      } catch (e) {}
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

  /* 当前是否"真的在处理"：开关打开 且 没选中无损直通（旁路）预设 */
  function activeOn() {
    var p = PRESETS[cfg.preset]
    return !!cfg.enabled && !(p && p.bypass)
  }

  /* 宽度矩阵的侧路增益（含相位一致性约束：反相内容不展宽） */
  function sideGain(w) {
    return 1 + clamp(w, 0, 1) * 1.6 * Math.pow(clamp(meter.corr, 0, 1), 0.6)
  }

  /* 自动 headroom：按"最大单段正增益"（EQ 峰与低音架取较大者）+ 激励湿声，
     在 preGain 上整体预衰减。
     为什么不用各段求和：各段中心频率不同，几乎不会同相叠加，逐段求和会把音量
     压死（实测 sum 口径可达 22dB，用户会以为没声音）；这里取主导项 + 激励项，
     剩余偶发叠加交给常开的末端限幅器兜底，既有余量又不牺牲响度。
     宽度不参与：mid 补偿已保证展宽时总峰值不上升。 */
  function headroomDb() {
    if (!activeOn()) return 0
    var maxEq = 0
    for (var i = 0; i < 10; i++) {
      var v = Number(cfg.eq[i]) || 0
      if (v > maxEq) maxEq = v
    }
    var bassDb = clamp(cfg.bass, 0, 1) * MAX_BASS_DB
    var ex = clamp(cfg.exciter, 0, 1)
    var excDb = ex > 0 ? gainToDb(1 + ex * EXC_MAX_WET) : 0
    var dom = maxEq > bassDb ? maxEq : bassDb
    return clamp(dom + excDb, 0, HEADROOM_MAX_DB)
  }

  function applyWidth(t) {
    if (!nodes) return
    var w = activeOn() ? clamp(cfg.width, 0, 1) : 0
    var factor = widthFactor()
    var gS = sideGain(w)
    /* mid 补偿：侧路放大的同时压低中间声道，使 M/S 重建后的峰值不随 width 上升
       （旧版只有 1/(1+0.35w) 的弱补偿，width=1 时 L/R 峰值仍会超出 1.0） */
    var gM = 1 / (1 + 0.55 * w * factor)
    nodes.gS.gain.setTargetAtTime(gS, t, 0.06)
    nodes.gSn.gain.setTargetAtTime(-gS, t, 0.06)
    nodes.gM.gain.setTargetAtTime(gM, t, 0.06)
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
          /* v59：末端软钳的顶就是 -1dBFS(0.891)，触到顶即计一次"已限幅"，而非等 0.999 硬削 */
          if (a >= CLIP_CEIL * 0.998) clip++
        }
        for (var j = 0; j < meter.bufOR.length; j++) {
          var b = meter.bufOR[j] < 0 ? -meter.bufOR[j] : meter.bufOR[j]
          if (b > peak) peak = b
          if (b >= CLIP_CEIL * 0.998) clip++
        }
        meter.peak = peak
        meter.peakHold = Math.max(peak, meter.peakHold * 0.9)
        meter.clip += clip
        meter.rmsL = Math.sqrt(meanSq(meter.bufOL))
        meter.rmsR = Math.sqrt(meanSq(meter.bufOR))
      }

      /* 限幅器状态：压缩器 reduction 为负值表示正在压，接近 0 表示透明直通 */
      if (nodes.comp && typeof nodes.comp.reduction === 'number') {
        var red = nodes.comp.reduction
        meter.limReduction = red
        meter.limActive = red < -0.2
      }

      /* 母带胶水压缩 GR：同理读 DynamicsCompressor.reduction（旧 WebView 可能不暴露，先判类型） */
      if (cfg.mastering.on && nodes.mbGlue && typeof nodes.mbGlue.reduction === 'number') {
        var mbRed = nodes.mbGlue.reduction
        meter.mbGr = mbRed
        meter.mbActive = mbRed < -0.2
      } else if (!cfg.mastering.on) {
        meter.mbGr = 0
        meter.mbActive = false
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
    meter.limReduction = 0
    meter.limActive = false
    meter.mbGr = 0
    meter.mbActive = false
    meter.mbApplied = false
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

  /* ---------------- 母带总线参数下发 ----------------
     use = 音效开着（非无损直通）且母带开关打开。
     关闭时 mbDry=1 / mbWet=0，信号只经过一个增益为 1 的节点，与"没有母带模块"等价。 */
  function applyMastering(t, on) {
    if (!nodes || !nodes.mbIn || !nodes.mbDry || !nodes.mbWet) return
    var mb = cfg.mastering
    var use = !!on && !!mb.on

    /* 30ms 交叉淡化：开关母带时不会出现电平跳变/爆音 */
    nodes.mbDry.gain.setTargetAtTime(use ? 0 : 1, t, 0.03)
    nodes.mbWet.gain.setTargetAtTime(use ? 1 : 0, t, 0.03)

    if (!use) {
      meter.mbApplied = false
      meter.mbGr = 0
      meter.mbActive = false
      meter.mbGlue = 0
      meter.mbSat = 0
      meter.mbAirDb = 0
      meter.mbPresenceDb = 0
      meter.mbMakeupDb = 0
      meter.mbWidth = 0
      /* 湿路也回到中性，保证下次开启时不会突然带上旧值 */
      nodes.mbSatWet.gain.setTargetAtTime(0, t, 0.03)
      nodes.mbPresence.gain.setTargetAtTime(0, t, 0.03)
      nodes.mbAir.gain.setTargetAtTime(0, t, 0.03)
      nodes.mbMakeup.gain.setTargetAtTime(1, t, 0.03)
      nodes.mbSideG.gain.setTargetAtTime(1, t, 0.03)
      nodes.mbSideNeg.gain.setTargetAtTime(-1, t, 0.03)
      nodes.mbMidG.gain.setTargetAtTime(1, t, 0.03)
      return
    }

    var mp = masterPreset()
    var g = clamp(mb.glue, 0, 1)
    var thr = masterGlueThreshold(g)
    var ratio = masterGlueRatio(g)
    nodes.mbGlue.threshold.setTargetAtTime(thr, t, 0.05)
    nodes.mbGlue.knee.setTargetAtTime(6, t, 0.05)
    nodes.mbGlue.ratio.setTargetAtTime(ratio, t, 0.05)
    nodes.mbGlue.attack.setTargetAtTime(MB_GLUE_ATK, t, 0.05)
    nodes.mbGlue.release.setTargetAtTime(MB_GLUE_REL, t, 0.05)

    /* makeup 只做"补回被压掉的响度"，上限 3dB；超出部分交给末级限幅，不在这里硬抬 */
    var makeupDb = clamp(mp.makeup || 0, 0, 3)
    nodes.mbMakeup.gain.setTargetAtTime(dbToGain(makeupDb), t, 0.05)

    var presDb = clamp(mp.presence || 0, 0, MB_MAX_PRESENCE_DB)
    var presFreq = clamp(mp.presenceFreq || 3000, 2000, 4000)
    nodes.mbPresence.frequency.setTargetAtTime(presFreq, t, 0.05)
    nodes.mbPresence.gain.setTargetAtTime(presDb, t, 0.05)

    var airDb = clamp(clamp(mb.air, 0, 1) * MB_MAX_AIR_DB, 0, MB_MAX_AIR_DB)
    nodes.mbAir.gain.setTargetAtTime(airDb, t, 0.05)

    nodes.mbHp.frequency.setTargetAtTime(MB_HP, t, 0.05)
    nodes.mbSideHp.frequency.setTargetAtTime(MB_MONO_HZ, t, 0.05)

    /* 展宽：受相关度约束（反相内容不展宽），并同步压低 mid 保证峰值不上升 */
    var wf = widthFactor()
    var wb = clamp(mb.width, 0, 1) * MB_MAX_WIDTH * wf
    var sideG = 1 + wb
    var midG = 1 / (1 + 0.55 * wb)
    nodes.mbSideG.gain.setTargetAtTime(sideG, t, 0.05)
    nodes.mbSideNeg.gain.setTargetAtTime(-sideG, t, 0.05)
    nodes.mbMidG.gain.setTargetAtTime(midG, t, 0.05)

    /* 并联饱和：drive 1~1.8 推入曲线，湿声 ≤0.30，干声始终直通 */
    var sat = clamp(mb.sat, 0, 1)
    nodes.mbSatDrive.gain.setTargetAtTime(1 + sat * 0.8, t, 0.05)
    nodes.mbSatWet.gain.setTargetAtTime(sat * MB_MAX_SAT_WET, t, 0.05)

    meter.mbApplied = true
    meter.mbGlue = g
    meter.mbSat = sat
    meter.mbAirDb = airDb
    meter.mbPresenceDb = presDb
    meter.mbMakeupDb = makeupDb
    meter.mbWidth = wb
  }

  function apply() {
    if (!nodes || !ctx) return
    applying = true
    try {
      var t = ctx.currentTime
      var pset = PRESETS[cfg.preset] || null
      var bypassPreset = !!(pset && pset.bypass)
      var on = !!cfg.enabled && !bypassPreset
      setRoute(!on)

      var eq = on ? cfg.eq : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      for (var i = 0; i < nodes.eq.length; i++) {
        nodes.eq[i].gain.setTargetAtTime(clamp(eq[i] || 0, -12, 12), t, 0.02)
      }

      /* 自动 headroom：整链预衰减，保证 EQ/低音/激励/展宽叠加后不超 0dBFS */
      var hr = on ? headroomDb() : 0
      meter.headroomDb = hr
      nodes.pre.gain.setTargetAtTime(dbToGain(-hr), t, 0.05)

      /* 分频低音 + 谐波激励（tanh 曲线 + 30Hz 高通，drive ≤1.8，湿声 ≤0.35） */
      var bassDb = on ? clamp(cfg.bass, 0, 1) * MAX_BASS_DB : 0
      nodes.lowGain.gain.setTargetAtTime(dbToGain(bassDb), t, 0.03)
      var ex = on ? clamp(cfg.exciter, 0, 1) : 0
      nodes.excDrive.gain.setTargetAtTime(1 + ex * (EXC_MAX_DRIVE - 1), t, 0.03)
      nodes.excWet.gain.setTargetAtTime(ex * EXC_MAX_WET, t, 0.03)

      /* 空间感 */
      var preset = pset || PRESETS.original
      var amb = on ? clamp(preset.ambience || 0, 0, 1) : 0
      var mode = on ? (cfg.ambienceMode || 'ir') : 'off'
      if (mode === 'ir' && amb > 0) ensureIR()
      var irOk = mode === 'ir' && !!nodes.conv && !!nodes.conv.buffer && !!nodes.irWet
      var legacy = mode === 'legacy'
      if (nodes.irWet) nodes.irWet.gain.setTargetAtTime(irOk ? amb * MAX_IR_WET : 0, t, 0.06)
      nodes.wet.gain.setTargetAtTime(legacy ? amb * 0.45 : 0, t, 0.06)
      nodes.fb.gain.setTargetAtTime(legacy ? amb * 0.2 : 0, t, 0.06)
      nodes.ambDry.gain.setTargetAtTime(1, t, 0.03)

      /* 宽度矩阵（含 mid 补偿） */
      applyWidth(t)

      /* 母带总线：在 R128 响度之后、限幅之前着色与整合响度 */
      applyMastering(t, on)

      /* 限幅器常开：与 R128 无关，参数固定，末端 -1dBFS 是硬上限 */
      nodes.comp.threshold.setTargetAtTime(LIMIT_THRESHOLD, t, 0.05)
      nodes.comp.knee.setTargetAtTime(0, t, 0.05)
      nodes.comp.ratio.setTargetAtTime(20, t, 0.05)
      nodes.comp.attack.setTargetAtTime(0.001, t, 0.05)
      nodes.comp.release.setTargetAtTime(0.15, t, 0.05)

      /* 响度标准化：只在开启时调 loud 增益，且仍受前端 headroom 与末端软钳约束 */
      if (!(on && cfg.r128)) {
        meter.gainDb = 0
        setLoudGain(1, t)
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
    MASTER_PRESETS: MASTER_PRESETS,

    /** 载入持久化配置（不建链，避免未开音效时被 AudioContext 挂起影响出声） */
    load: function (saved) {
      var migrated = false
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
        /* v60 母带总线：缺字段时回落到 clear 预设的默认值，保证老配置升级后不炸 */
        var sm = saved.mastering && typeof saved.mastering === 'object' ? saved.mastering : {}
        var smp = MASTER_PRESETS[sm.preset] ? sm.preset : 'clear'
        cfg.mastering = {
          on: MASTER_DEFAULT_ON,
          userSet: false,
          preset: smp,
          glue: clamp(sm.glue === undefined ? MASTER_PRESETS[smp].glue : sm.glue, 0, 1),
          sat: clamp(sm.sat === undefined ? MASTER_PRESETS[smp].sat : sm.sat, 0, 1),
          air: clamp(sm.air === undefined ? MASTER_PRESETS[smp].air : sm.air, 0, 1),
          width: clamp(sm.width === undefined ? MASTER_PRESETS[smp].width : sm.width, 0, 1),
        }
        /* v62：母带默认开启的配置兼容，按四级判定：
             1) userSet === true —— 用户在 v62+ 手动开/关过母带，永久尊重其选择
             2) cfgVer >= 2     —— 已是新版本配置，按存储值（缺字段才回落默认）
             3) 老配置但有痕迹   —— 换过风格或动过滑杆（值偏离 clear 默认），视为人工调过母带，
                                   保留其存下的 on（尤其"曾手动关掉"必须保持关闭）
             4) 其余为老配置    —— v60/v61 母带默认就是关闭，on:false 只是默认值而非用户意图，
                                   因此统一迁移到新默认（开启）；老配置里用户主动开启过的
                                   （on:true）结果同样为开启，与旧行为一致。 */
        var savedVer = Number(saved.cfgVer) || 0
        var userSet = sm.userSet === true
        var touched = false
        if (sm.preset && MASTER_PRESETS[sm.preset] && sm.preset !== 'clear') touched = true
        ;['glue', 'sat', 'air', 'width'].forEach(function (k) {
          if (sm[k] !== undefined && Math.abs(Number(sm[k]) - MASTER_PRESETS.clear[k]) > 0.001) touched = true
        })
        cfg.mastering.userSet = userSet
        if (userSet) {
          cfg.mastering.on = !!sm.on
        } else if (savedVer >= AUDIOFX_CFG_VER) {
          cfg.mastering.on = sm.on === undefined ? MASTER_DEFAULT_ON : !!sm.on
        } else if (touched) {
          cfg.mastering.on = !!sm.on
        } else {
          cfg.mastering.on = MASTER_DEFAULT_ON
        }
        /* 老配置升级时，若母带被新默认打开而音效链还关着（v60/v61 默认关），一并打开；
           新版配置则尊重用户对音效链的开关，不再强行打开（否则关掉音效链重启会被复位） */
        if (!userSet && savedVer < AUDIOFX_CFG_VER && cfg.mastering.on && !cfg.enabled) cfg.enabled = true
        migrated = savedVer < AUDIOFX_CFG_VER || sm.userSet === undefined
      } else {
        /* 没有历史配置（首次安装）：直接用新默认 */
        migrated = true
      }
      if (audioEl && cfg.enabled) { build(); resume(); apply() }
      /* 迁移后立刻回写一次，把 cfgVer / userSet 落到磁盘，避免每次启动重复迁移 */
      if (migrated) persist()
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

    /** 母带总线开关：关闭时信号只过一个增益为 1 的节点，与没有母带模块等价 */
    setMastering: function (on) {
      cfg.mastering.on = !!on
      /* v62：记下"用户手动开/关过"，后续升级不再覆盖他的选择 */
      cfg.mastering.userSet = true
      /* 母带只能在音效链里生效：单独打开母带时自动把音效链一并打开，语义更直观 */
      if (cfg.mastering.on && !cfg.enabled) cfg.enabled = true
      if (cfg.enabled) { build(); resume() }
      apply()
      persist()
      return cfg.mastering.on
    },

    /** 母带风格预设（Clear / Warm / Punch / Loud）：会覆盖四个归一量参数 */
    setMasterPreset: function (key) {
      var p = MASTER_PRESETS[key]
      if (!p) return false
      cfg.mastering.preset = key
      cfg.mastering.userSet = true
      cfg.mastering.glue = p.glue
      cfg.mastering.sat = p.sat
      cfg.mastering.air = p.air
      cfg.mastering.width = p.width
      cfg.mastering.on = true
      if (!cfg.enabled) cfg.enabled = true
      build()
      resume()
      apply()
      persist()
      return true
    },

    /** 单项母带参数：glue(胶水) / sat(饱和) / air(空气感) / width(宽度)，取值 0~1 */
    setMasterParam: function (key, v) {
      if (['glue', 'sat', 'air', 'width'].indexOf(key) < 0) return false
      cfg.mastering[key] = clamp(v, 0, 1)
      cfg.mastering.userSet = true
      cfg.mastering.on = true
      if (!cfg.enabled) cfg.enabled = true
      build()
      resume()
      apply()
      persist()
      return cfg.mastering[key]
    },

    /** 母带当前参数快照（供 UI 同步滑杆与按钮态） */
    mastering: function () {
      var mp = masterPreset()
      return {
        on: !!cfg.mastering.on,
        userSet: !!cfg.mastering.userSet,
        preset: cfg.mastering.preset,
        presetName: mp.name,
        glue: cfg.mastering.glue,
        sat: cfg.mastering.sat,
        air: cfg.mastering.air,
        width: cfg.mastering.width,
        presenceDb: mp.presence,
        presenceFreq: mp.presenceFreq,
        makeupDb: mp.makeup,
      }
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
      /* 无损直通预设 = 零处理旁路：把开关语义一并置为关闭，保证 src 直连输出 */
      if (p.bypass) cfg.enabled = false
      else if (!cfg.enabled) cfg.enabled = true
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

    /** 是否处于"零处理"状态（关闭音效或选中无损直通预设） */
    isLossless: function () {
      var p = PRESETS[cfg.preset]
      return !cfg.enabled || !!(p && p.bypass)
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
          clipping: meter.peak >= CLIP_CEIL * 0.998,
        },
        /* 限幅器诊断：常开，-1dBFS 硬上限；triggerDb 为压缩器开始压的阈值，
           reductionDb 为当前实际衰减量（0 表示透明），active 表示此刻正在限幅 */
        limit: {
          on: true,
          ceilingDb: gainToDb(CLIP_CEIL),
          thresholdDb: LIMIT_THRESHOLD,
          reductionDb: meter.limReduction,
          active: !!meter.limActive,
          lookaheadMs: LOOKAHEAD * 1000,
        },
        headroomDb: meter.headroomDb,
        /* 母带总线诊断：on=用户开关，applied=此刻确实在处理（音效开着且母带开着），
           grDb 为胶水压缩当前衰减量，truePeakHoldDb 为总输出峰值保持（-1dBFS 为顶） */
        mastering: {
          on: !!cfg.mastering.on,
          applied: !!meter.mbApplied,
          preset: cfg.mastering.preset,
          presetName: masterPreset().name,
          glue: cfg.mastering.glue,
          glueThresholdDb: masterGlueThreshold(cfg.mastering.glue),
          glueRatio: masterGlueRatio(cfg.mastering.glue),
          glueAttackMs: MB_GLUE_ATK * 1000,
          glueReleaseMs: MB_GLUE_REL * 1000,
          grDb: masterGrDb(),
          active: masterGrDb() < -0.2,
          sat: cfg.mastering.sat,
          satWet: clamp(cfg.mastering.sat, 0, 1) * MB_MAX_SAT_WET,
          air: cfg.mastering.air,
          airDb: meter.mbAirDb,
          airFreq: MB_AIR_FREQ,
          presenceDb: meter.mbPresenceDb,
          presenceFreq: masterPreset().presenceFreq,
          width: cfg.mastering.width,
          widthBoost: meter.mbWidth,
          monoHz: MB_MONO_HZ,
          hpHz: MB_HP,
          makeupDb: meter.mbMakeupDb,
          ceilingDb: gainToDb(CLIP_CEIL),
          truePeakHoldDb: gainToDb(meter.peakHold),
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
