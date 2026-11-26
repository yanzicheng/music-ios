'use strict'
/**
 * Cordova hook：after_prepare
 *
 * v55（真机问题 1「音乐在放但没声音」/ 问题 8 自检）：
 * iOS 上 WKWebView 播放媒体时，进程的 AVAudioSession 默认是 Ambient 类别 ——
 *   1. 受静音拨片控制：拨片一拨到静音，进度条照走，但一点声音都没有；
 *   2. 不允许后台出声：config.xml/hook 里已经声明 UIBackgroundModes=audio，
 *      但类别不是 Playback 时，切后台/锁屏立刻被掐断。
 * 安卓版没有这层概念，所以这是 iOS 独有的"没声音"来源。
 *
 * 因此这里在 AppDelegate 启动时显式设置：
 *   AVAudioSessionCategoryPlayback（音乐类 App 标准类别，忽略静音拨片、支持后台）
 *   AVAudioSessionCategoryOptionMixWithOthers 之外的默认选项（不加，保证独占清晰）
 *
 * platforms/ 每次 CI 都会重新生成，所以必须用 hook 打补丁，手改无效。
 * 同时兼容 Objective-C（AppDelegate.m / .mm）与 Swift（AppDelegate.swift）两种模板，
 * 脚本只做文本级插入，不依赖任何 npm 包。
 */

const fs = require('fs')
const path = require('path')

const MARK = 'LXAudioSessionConfigured'
const OBJC_IMPORT = '#import <AVFoundation/AVFoundation.h>\n'
const OBJC_BODY = [
  '',
  '    // ' + MARK + '：音乐类 App 固定 Playback 类别（忽略静音拨片、支持锁屏/后台播放）',
  '    NSError *lxAudioErr = nil;',
  '    [[AVAudioSession sharedInstance] setCategory:AVAudioSessionCategoryPlayback error:&lxAudioErr];',
  '    [[AVAudioSession sharedInstance] setActive:YES withOptions:0 error:&lxAudioErr];',
  '    if (lxAudioErr) { NSLog(@"[LX] AVAudioSession 配置失败: %@", lxAudioErr); }',
  '    [[UIApplication sharedApplication] beginReceivingRemoteControlEvents];',
  ''
].join('\n')

const SWIFT_IMPORT = 'import AVFoundation\n'
const SWIFT_BODY = [
  '        // ' + MARK + '：音乐类 App 固定 Playback 类别（忽略静音拨片、支持锁屏/后台播放）',
  '        do {',
  '            let session = AVAudioSession.sharedInstance()',
  '            try session.setCategory(.playback, mode: .default, options: [])',
  '            try session.setActive(true)',
  '        } catch {',
  '            NSLog("[LX] AVAudioSession 配置失败: \\(error)")',
  '        }',
  ''
].join('\n')

function walk (dir, depth, out) {
  if (depth > 3) return
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'Pods' || ent.name === 'build' || ent.name === 'node_modules' || ent.name === '.git') continue
      walk(full, depth + 1, out)
    } else if (/^AppDelegate\.(m|mm|swift)$/.test(ent.name)) {
      out.push(full)
    }
  }
}

function patchObjc (xml) {
  let out = xml

  if (out.indexOf(MARK) !== -1) return null

  if (out.indexOf('AVFoundation/AVFoundation.h') === -1) {
    // 插到第一处 #import 之前，保证头文件可用
    const m = out.match(/^#import[^\n]*\n/m)
    if (m && m.index !== undefined) {
      out = out.slice(0, m.index) + OBJC_IMPORT + out.slice(m.index)
    } else {
      out = OBJC_IMPORT + out
    }
  }

  // 定位 didFinishLaunchingWithOptions 的方法体起始大括号
  const re = /(-\s*\(BOOL\)\s*application:[\s\S]{0,120}?didFinishLaunchingWithOptions:[\s\S]{0,200}?\)\s*\{)/
  const m = out.match(re)
  if (!m) {
    // 兼容部分模板写成 (BOOL)application:(UIApplication*)application didFinishLaunchingWithOptions:(NSDictionary*)launchOptions
    const re2 = /(didFinishLaunchingWithOptions[\s\S]{0,160}?\{)/
    const m2 = out.match(re2)
    if (!m2) return null
    return out.slice(0, m2.index + m2[1].length) + OBJC_BODY + out.slice(m2.index + m2[1].length)
  }
  return out.slice(0, m.index + m[1].length) + OBJC_BODY + out.slice(m.index + m[1].length)
}

function patchSwift (src) {
  if (src.indexOf(MARK) !== -1) return null
  let out = src
  if (out.indexOf('import AVFoundation') === -1) {
    const idx = out.indexOf('import UIKit')
    if (idx === -1) out = SWIFT_IMPORT + out
    else out = out.slice(0, idx) + SWIFT_IMPORT + out.slice(idx)
  }
  const re = /(didFinishLaunchingWithOptions[\s\S]{0,200}?\{\n)/
  const m = out.match(re)
  if (!m) return null
  const at = m.index + m[1].length
  return out.slice(0, at) + SWIFT_BODY + out.slice(at)
}

module.exports = function (ctx) {
  const platforms = (ctx.opts && ctx.opts.platforms) || []
  if (platforms.length && platforms.indexOf('ios') === -1) return Promise.resolve()

  const projectRoot = (ctx.opts && ctx.opts.projectRoot) || path.resolve('.')
  const platformRoot = path.join(projectRoot, 'platforms', 'ios')
  if (!fs.existsSync(platformRoot)) {
    console.log('[ios-avsession-patch] 未找到 platforms/ios，跳过')
    return Promise.resolve()
  }

  const files = []
  walk(platformRoot, 0, files)
  if (!files.length) {
    console.warn('[ios-avsession-patch] 未找到 AppDelegate，跳过')
    return Promise.resolve()
  }

  for (const file of files) {
    const isSwift = /\.swift$/.test(file)
    let src
    try {
      src = fs.readFileSync(file, 'utf8')
    } catch (e) {
      console.error('[ios-avsession-patch] 读取失败 ' + file + ': ' + e.message)
      continue
    }
    const next = isSwift ? patchSwift(src) : patchObjc(src)
    if (!next) {
      console.log('[ios-avsession-patch] ' + path.relative(projectRoot, file) + ' 无需改动')
      continue
    }
    try {
      fs.writeFileSync(file, next, 'utf8')
      console.log('[ios-avsession-patch] ' + path.relative(projectRoot, file) + ' -> 已写入 AVAudioSession(Playback)')
    } catch (e) {
      console.error('[ios-avsession-patch] 写入失败 ' + file + ': ' + e.message)
    }
  }

  return Promise.resolve()
}
