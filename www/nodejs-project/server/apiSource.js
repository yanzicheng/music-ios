'use strict'
/**
 * 洛雪自定义音源运行时（LX Custom Source Runtime）
 * 在 Node 的 vm 沙箱中加载洛雪格式的音源脚本（*.js），提供其所需的 globalThis.lx 接口。
 *
 * 音源脚本能力：
 *   lx.on('request', handler)  接收 { source, action, info }，返回 Promise
 *       action: musicUrl / lyric / pic
 *   lx.send('inited', { status, message, sources: { kw: { qualitys:[], actions:[] }, ... } })
 */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const http = require('node:http')
const https = require('node:https')
const { URL } = require('node:url')

const EVENT_NAMES = {
  request: 'request',
  inited: 'inited',
  updateAlert: 'updateAlert',
}

const ALL_SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg', 'local']
const SUPPORT_QUALITYS = {
  kw: ['128k', '320k', 'flac', 'flac24bit'],
  kg: ['128k', '320k', 'flac', 'flac24bit'],
  tx: ['128k', '320k', 'flac', 'flac24bit'],
  wy: ['128k', '320k', 'flac', 'flac24bit'],
  mg: ['128k', '320k', 'flac', 'flac24bit'],
  local: [],
}
const SUPPORT_ACTIONS = {
  kw: ['musicUrl'], kg: ['musicUrl'], tx: ['musicUrl'], wy: ['musicUrl'], mg: ['musicUrl'],
  xm: ['musicUrl'], local: ['musicUrl', 'lyric', 'pic'],
}

/** 音源脚本内部使用的 HTTP 请求（回调风格，兼容 needle 返回结构） */
function lxRequest(url, options = {}, callback) {
  let reqRef = null
  let aborted = false
  const method = (options.method || 'get').toUpperCase()
  const headers = Object.assign({}, options.headers)
  let payload = null
  if (options.body) payload = typeof options.body === 'string' ? Buffer.from(options.body) : Buffer.from(JSON.stringify(options.body))
  else if (options.form) payload = Buffer.from(new URLSearchParams(options.form).toString())
  else if (options.formData) payload = Buffer.from(new URLSearchParams(options.formData).toString())
  if (payload && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = options.form || options.formData ? 'application/x-www-form-urlencoded' : 'application/json'
  }
  if (payload) headers['Content-Length'] = payload.length

  const timeout = Math.min(Math.max(options.response_timeout || 15000, 1000), 60000)
  const lib = /^https:/.test(url) ? https : http
  try {
    const req = lib.request(url, { method, headers, timeout, rejectUnauthorized: false }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        let raw = Buffer.concat(chunks)
        const enc = String(res.headers['content-encoding'] || '').toLowerCase()
        try {
          if (enc === 'gzip') raw = zlib.gunzipSync(raw)
          else if (enc === 'deflate') raw = zlib.inflateSync(raw)
          else if (enc === 'br') raw = zlib.brotliDecompressSync(raw)
        } catch (_) {}
        let body = raw.toString()
        try { body = JSON.parse(body) } catch (_) {}
        const resp = {
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers,
          bytes: raw.length,
          raw,
          body,
        }
        try { callback && callback.call(null, null, resp, body) } catch (e) { /* 音源内部异常忽略 */ }
      })
    })
    req.on('error', err => { if (!aborted) try { callback && callback.call(null, err, null, null) } catch (_) {} })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    reqRef = req
    if (payload) req.write(payload)
    req.end()
  } catch (e) {
    try { callback && callback.call(null, e, null, null) } catch (_) {}
  }

  return () => {
    aborted = true
    try { reqRef && reqRef.destroy() } catch (_) {}
  }
}

const lxUtils = {
  crypto: {
    aesEncrypt(buffer, mode, key, iv) {
      const cipher = crypto.createCipheriv(mode, key, iv)
      return Buffer.concat([cipher.update(buffer), cipher.final()])
    },
    rsaEncrypt(buffer, key) {
      const buf = Buffer.concat([Buffer.alloc(Math.max(0, 128 - buffer.length)), buffer])
      return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, buf)
    },
    randomBytes(size) { return crypto.randomBytes(size) },
    md5(str) { return crypto.createHash('md5').update(str).digest('hex') },
  },
  buffer: {
    from(...args) { return Buffer.from(...args) },
    bufToString(buf, format) { return Buffer.from(buf, 'binary').toString(format) },
  },
  zlib: {
    inflate(buf) { return new Promise((resolve, reject) => zlib.inflate(buf, (e, d) => e ? reject(new Error(e.message)) : resolve(d))) },
    deflate(data) { return new Promise((resolve, reject) => zlib.deflate(data, (e, b) => e ? reject(new Error(e.message)) : resolve(b))) },
  },
}

/** 解析脚本头部的 @name @version 等注释信息 */
function parseMeta(code, fileName) {
  const head = code.slice(0, 4000)
  const pick = key => {
    const m = head.match(new RegExp(`@${key}\\s+([^\\r\\n*]+)`))
    return m ? m[1].trim() : ''
  }
  return {
    name: pick('name') || path.basename(fileName, '.js'),
    description: pick('description'),
    version: pick('version'),
    author: pick('author'),
    homepage: pick('homepage'),
    fileName: path.basename(fileName),
    filePath: fileName,
  }
}

/** 单个音源实例 */
class ApiSource {
  constructor(filePath, { log = () => {} } = {}) {
    this.filePath = filePath
    this.log = log
    this.code = fs.readFileSync(filePath, 'utf8')
    this.meta = parseMeta(this.code, filePath)
    this.status = 'idle' // idle | loading | ready | error
    this.error = null
    this.sources = {} // { tx: { qualitys:[], actions:[] } }
    this.requestHandler = null
    this.sandbox = null
  }

  /** 初始化（加载脚本并等待 lx.send('inited')） */
  init(timeout = 20000) {
    if (this.status === 'ready') return Promise.resolve(this)
    if (this.initing) return this.initing
    this.status = 'loading'

    this.initing = new Promise((resolve, reject) => {
      let settled = false
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) {
          this.status = 'error'
          this.error = err.message || String(err)
          return reject(err)
        }
        this.status = 'ready'
        resolve(this)
      }

      const timer = setTimeout(() => finish(new Error('音源初始化超时')), timeout)

      const sandbox = {
        console: {
          log: (...a) => this.log('[log]', ...a),
          info: (...a) => this.log('[info]', ...a),
          warn: (...a) => this.log('[warn]', ...a),
          error: (...a) => this.log('[error]', ...a),
          debug: () => {},
          // 部分音源脚本使用分组/表格/计时等扩展方法，缺失会直接抛错
          group: (...a) => this.log('[group]', ...a),
          groupCollapsed: (...a) => this.log('[group]', ...a),
          groupEnd: () => {},
          table: (...a) => this.log('[table]', ...a),
          trace: (...a) => this.log('[trace]', ...a),
          dir: (...a) => this.log('[dir]', ...a),
          time: () => {},
          timeEnd: () => {},
          assert: () => {},
          count: () => {},
        },
        setTimeout, clearTimeout, setInterval, clearInterval,
        setImmediate, clearImmediate,
        queueMicrotask,
        Buffer, URL, URLSearchParams, TextEncoder, TextDecoder,
        Promise, Date, Math, JSON, Reflect, Proxy,
        atob: s => Buffer.from(String(s), 'base64').toString('binary'),
        btoa: s => Buffer.from(String(s), 'binary').toString('base64'),
        process: { versions: { node: process.versions.node }, env: {}, platform: process.platform, nextTick: process.nextTick },
        fetch: (...args) => fetch(...args),
        crypto: crypto.webcrypto,
        performance,
        navigator: { userAgent: require('./net').DEFAULT_UA, platform: 'Win32', language: 'zh-CN' },
        lx: {
          EVENT_NAMES,
          version: '2.0.0',
          env: 'desktop',
          currentScriptInfo: {
            name: this.meta.name,
            description: this.meta.description,
            version: this.meta.version,
            author: this.meta.author,
            homepage: this.meta.homepage,
            rawScript: this.code,
          },
          request: (url, options, callback) => lxRequest(url, options, callback),
          send: (eventName, data) => {
            return new Promise((res, rej) => {
              if (!Object.values(EVENT_NAMES).includes(eventName)) return rej(new Error('The event is not supported: ' + eventName))
              if (eventName === EVENT_NAMES.inited) {
                if (!data || typeof data !== 'object') return finish(new Error('初始化信息缺失'))
                const sources = {}
                try {
                  for (const source of ALL_SOURCES) {
                    const us = data.sources && data.sources[source]
                    if (!us || us.type !== 'music') continue
                    const actions = (SUPPORT_ACTIONS[source] || ['musicUrl']).filter(a => (us.actions || []).includes(a))
                    const qualitys = (SUPPORT_QUALITYS[source] || []).filter(q => (us.qualitys || []).includes(q))
                    sources[source] = { type: 'music', actions, qualitys }
                  }
                } catch (e) {
                  return finish(e)
                }
                this.sources = sources
                this.initMessage = typeof data.message === 'string' ? data.message : ''
                finish()
                return res()
              }
              if (eventName === EVENT_NAMES.updateAlert) {
                this.log('[updateAlert]', JSON.stringify(data))
                return res()
              }
              rej(new Error('Unknown event name: ' + eventName))
            })
          },
          utils: lxUtils,
          on: (eventName, handler) => {
            if (eventName === EVENT_NAMES.request) {
              this.requestHandler = handler
              return Promise.resolve()
            }
            return Promise.reject(new Error('The event is not supported: ' + eventName))
          },
        },
      }
      sandbox.globalThis = sandbox
      sandbox.window = sandbox
      sandbox.self = sandbox
      this.sandbox = vm.createContext(sandbox)

      try {
        vm.runInContext(this.code, this.sandbox, { filename: this.meta.fileName, timeout: 30000 })
      } catch (e) {
        finish(new Error('音源脚本执行异常: ' + e.message))
      }
    })
    return this.initing
  }

  /** 是否支持某平台某动作 */
  support(source, action) {
    const s = this.sources[source]
    return !!(s && s.actions && s.actions.includes(action))
  }

  /** 支持的平台列表 */
  get sourceList() {
    return Object.keys(this.sources)
  }

  /**
   * 发起请求
   * @param {{source:string, action:string, info:object}} params
   */
  async request({ source, action, info }) {
    if (this.status !== 'ready') await this.init()
    if (!this.requestHandler) throw new Error('音源未实现 request 事件')
    const timeoutMs = 30000
    const result = await Promise.race([
      this.requestHandler.call(this.sandbox, { source, action, info }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('音源请求超时')), timeoutMs)),
    ])
    // 结果校验（与洛雪一致）
    if (action === 'musicUrl' || action === 'pic') {
      if (typeof result !== 'string' || result.length > 2048 || !/^https?:/.test(result)) throw new Error('音源返回的地址无效')
      return result
    }
    if (action === 'lyric') {
      if (typeof result !== 'object' || typeof result.lyric !== 'string') throw new Error('音源返回的歌词无效')
      return {
        lyric: result.lyric,
        tlyric: typeof result.tlyric === 'string' ? result.tlyric : null,
        rlyric: typeof result.rlyric === 'string' ? result.rlyric : null,
        lxlyric: typeof result.lxlyric === 'string' ? result.lxlyric : null,
      }
    }
    return result
  }
}

module.exports = {
  ApiSource,
  parseMeta,
  EVENT_NAMES,
  ALL_SOURCES,
  SUPPORT_QUALITYS,
}
