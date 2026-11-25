'use strict'
/**
 * 网络请求层（零第三方依赖，仅使用 Node 内置 http/https）
 * 输出的响应结构与洛雪内部 request 保持一致：
 *   { statusCode, statusMessage, headers, bytes, raw: Buffer, body: 解析后的内容 }
 */
const http = require('node:http')
const https = require('node:https')
const zlib = require('node:zlib')
const { URL } = require('node:url')

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36'

const bHh = '624868746c'
// 模拟客户端版本号（洛雪内部用于请求签名，非 Electron 环境用固定值）
const APP_VERSION = '2.12.6'

const regx = /(?:\d\w)+/g

function buildSigHeader(url) {
  const path = url.replace(/^https?:\/\/[\w.:]+\//, '/')
  let s = Buffer.from(bHh, 'hex').toString()
  s = s.replace(s.substr(-1), '')
  s = Buffer.from(s, 'base64').toString()
  const v = APP_VERSION.split('-')[0].split('.').map(n => n.length < 3 ? n.padStart(3, '0') : n).join('')
  const v2 = APP_VERSION.split('-')[1] || ''
  const payload = Buffer.from(JSON.stringify(`${path}${v}`.match(regx), null, 1).concat(v)).toString('base64')
  const sig = `${zlib.deflateRawSync(Buffer.from(payload)).toString('hex')}&${parseInt(v)}${v2}`
  return { name: s, value: sig }
}

/**
 * 底层请求
 * @param {string} rawUrl
 * @param {object} opts { method, headers, body, form, formData, timeout, json }
 * @returns {Promise<{statusCode,statusMessage,headers,bytes,raw,body}>}
 */
function rawRequest(rawUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(rawUrl)
    } catch (e) {
      return reject(new Error('无效的请求地址: ' + rawUrl))
    }
    const isHttps = url.protocol === 'https:'
    const lib = isHttps ? https : http
    const method = (opts.method || 'get').toUpperCase()
    const headers = Object.assign({}, opts.headers)

    // 构造请求体
    let payload = null
    const hasLower = k => Object.keys(headers).some(h => h.toLowerCase() === k)
    if (opts.body !== undefined && opts.body !== null) {
      if (typeof opts.body === 'string' || Buffer.isBuffer(opts.body)) {
        payload = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body)
      } else {
        payload = Buffer.from(JSON.stringify(opts.body))
        if (!hasLower('content-type')) headers['Content-Type'] = 'application/json'
      }
    } else if (opts.form) {
      payload = Buffer.from(new URLSearchParams(opts.form).toString())
      if (!hasLower('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    } else if (opts.formData) {
      payload = Buffer.from(new URLSearchParams(opts.formData).toString())
      if (!hasLower('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
    if (payload) headers['Content-Length'] = payload.length
    if (!hasLower('user-agent')) headers['User-Agent'] = DEFAULT_UA
    if (!hasLower('accept-encoding')) headers['Accept-Encoding'] = 'gzip, deflate, br'

    // 签名头（部分平台接口要求）
    if (headers[bHh]) {
      const sig = buildSigHeader(rawUrl)
      if (sig.name) headers[sig.name] = sig.value
      delete headers[bHh]
    }

    const reqOptions = {
      method,
      headers,
      timeout: Math.min(Math.max(opts.timeout || 15000, 1000), 60000),
      rejectUnauthorized: false,
    }
    if (url.username || url.password) {
      reqOptions.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
    }

    const req = lib.request(url, reqOptions, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        let raw = Buffer.concat(chunks)
        const enc = String(res.headers['content-encoding'] || '').toLowerCase()
        try {
          if (enc === 'gzip') raw = zlib.gunzipSync(raw)
          else if (enc === 'deflate') raw = zlib.inflateSync(raw)
          else if (enc === 'br') raw = zlib.brotliDecompressSync(raw)
        } catch (_) { /* 解压失败则原样返回 */ }
        const text = raw.toString('utf8')
        let body = text
        try { body = JSON.parse(text) } catch (_) { /* 非 JSON 保持字符串 */ }
        resolve({
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers,
          bytes: raw.length,
          raw,
          body,
        })
      })
    })

    req.on('error', err => reject(err))
    req.on('timeout', () => req.destroy(new Error('请求超时 (ETIMEDOUT)')))

    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * 与洛雪 httpFetch 同构：返回 { promise, cancelHttp }
 */
function httpFetch(url, options = { method: 'get' }) {
  let reqRef = null
  let cancelled = false
  const state = {
    isCancelled: false,
    promise: null,
    cancelHttp: () => {
      state.isCancelled = true
      cancelled = true
      if (reqRef && reqRef.destroy) try { reqRef.destroy() } catch (_) {}
    },
  }
  state.promise = rawRequest(url, options).then(resp => {
    if (cancelled) throw new Error('请求已取消')
    return resp
  })
  return state
}

/** 简化版：直接拿到响应对象 */
const fetchResp = (url, options = {}) => httpFetch(url, options).promise

/** 简化版：直接拿到文本 */
async function httpText(url, options = {}) {
  const resp = await rawRequest(url, options)
  return typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)
}

module.exports = {
  httpFetch,
  fetchResp,
  rawRequest,
  httpText,
  DEFAULT_UA,
  bHh,
}
