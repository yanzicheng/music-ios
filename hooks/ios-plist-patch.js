'use strict'
/**
 * Cordova hook：after_prepare
 *
 * 作用：把 iOS 必须的 Info.plist 键补齐到 platforms/ios/**\/*-Info.plist。
 * 为什么用 hook 而不是手改 platforms：platforms/ 由 `cordova platform add ios` 生成、不入库，
 * 每次 CI 都是全新生成，手改必然丢失。
 *
 * 写入内容（均幂等，已存在则跳过或按需合并）：
 *   CFBundleDisplayName        桌面显示名「音乐」（widget name 保持 ASCII 以稳定工程名/scheme）
 *   NSAppTransportSecurity    允许 http://127.0.0.1:34200 明文回环访问（本地 Node 服务）
 *   UIBackgroundModes         含 audio（锁屏 / 切后台继续出声）
 *   UIFileSharingEnabled      允许在「文件」App 里看到 App 文档目录（方便塞本地歌曲 / 导歌单）
 *   LSSupportsOpeningDocumentsInPlace  同上，配合文件共享使用
 *   UISupportedInterfaceOrientations   仅竖屏（与安卓 AndroidManifest 的 portrait 对齐）
 *   ITSAppUsesNonExemptEncryption      仅用系统 HTTPS，声明非豁免加密
 *
 * 注意：本脚本不依赖任何 npm 包（不 require plist / xcode），只用 Node 内置模块做文本级插入，
 * 因此在干净的 CI 环境里也能直接跑。
 */

const fs = require('fs')
const path = require('path')

const DISPLAY_NAME = '音乐'

/** 需要补齐的键：key 用于判断「是否已存在」 */
const ENTRIES = [
  {
    key: 'CFBundleDisplayName',
    xml: `\t<key>CFBundleDisplayName</key>\n\t<string>${DISPLAY_NAME}</string>\n`,
    replace: true
  },
  {
    key: 'NSAppTransportSecurity',
    xml: [
      '\t<key>NSAppTransportSecurity</key>',
      '\t<dict>',
      '\t\t<key>NSAllowsArbitraryLoads</key>',
      '\t\t<true/>',
      '\t\t<key>NSAllowsLocalNetworking</key>',
      '\t\t<true/>',
      '\t\t<key>NSExceptionDomains</key>',
      '\t\t<dict>',
      '\t\t\t<key>localhost</key>',
      '\t\t\t<dict>',
      '\t\t\t\t<key>NSExceptionAllowsInsecureHTTPLoads</key>',
      '\t\t\t\t<true/>',
      '\t\t\t\t<key>NSIncludesSubdomains</key>',
      '\t\t\t\t<true/>',
      '\t\t\t</dict>',
      '\t\t\t<key>127.0.0.1</key>',
      '\t\t\t<dict>',
      '\t\t\t\t<key>NSExceptionAllowsInsecureHTTPLoads</key>',
      '\t\t\t\t<true/>',
      '\t\t\t</dict>',
      '\t\t</dict>',
      '\t</dict>',
      ''
    ].join('\n'),
    replace: true
  },
  {
    key: 'UIBackgroundModes',
    xml: '\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>audio</string>\n\t</array>\n',
    mergeArray: 'audio'
  },
  {
    key: 'UIFileSharingEnabled',
    xml: '\t<key>UIFileSharingEnabled</key>\n\t<true/>\n',
    replace: true
  },
  {
    key: 'LSSupportsOpeningDocumentsInPlace',
    xml: '\t<key>LSSupportsOpeningDocumentsInPlace</key>\n\t<true/>\n',
    replace: true
  },
  {
    key: 'UISupportedInterfaceOrientations',
    xml: '\t<key>UISupportedInterfaceOrientations</key>\n\t<array>\n\t\t<string>UIInterfaceOrientationPortrait</string>\n\t</array>\n',
    replace: true
  },
  {
    key: 'UISupportedInterfaceOrientations~ipad',
    xml: '\t<key>UISupportedInterfaceOrientations~ipad</key>\n\t<array>\n\t\t<string>UIInterfaceOrientationPortrait</string>\n\t</array>\n',
    replace: true
  },
  {
    key: 'ITSAppUsesNonExemptEncryption',
    xml: '\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>\n',
    replace: true
  }
]

/** 在根 </dict></plist> 之前插入一段 XML */
function insertBeforeRootClose (xml, fragment) {
  const m = xml.match(/<\/dict>\s*<\/plist>\s*$/)
  if (!m) return null
  const idx = m.index
  return xml.slice(0, idx) + fragment + xml.slice(idx)
}

/** 已有同名 key 时，替换其后的首个值节点（简单结构：<string> / <true/> / <false/>） */
function replaceValue (xml, key, fragment) {
  const keyTag = new RegExp('(<key>' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</key>\\s*)(<string>[\\s\\S]*?</string>|<true\\s*/>|<false\\s*/>)')
  if (!keyTag.test(xml)) return null
  // fragment 里首个换行后的部分即值节点
  const valueXml = fragment.slice(fragment.indexOf('\n') + 1).trim()
  return xml.replace(keyTag, function (all, head) {
    return head + valueXml
  })
}

/** UIBackgroundModes 已存在但缺少目标模式时，往数组里补一项 */
function mergeArrayValue (xml, key, value) {
  const re = new RegExp('(<key>' + key + '</key>\\s*<array>)([\\s\\S]*?)(</array>)')
  const m = xml.match(re)
  if (!m) return null
  if (new RegExp('<string>' + value + '</string>').test(m[2])) return xml // 已含，无需改动
  const merged = m[1] + m[2].replace(/\s*$/, '\n\t\t') + '<string>' + value + '</string>\n\t' + m[3]
  return xml.replace(re, function () { return merged })
}

function findInfoPlists (platformRoot) {
  const out = []
  const walk = function (dir, depth) {
    if (depth > 3) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'Pods' || ent.name === 'build' || ent.name === 'node_modules' || ent.name === '.git') continue
        walk(full, depth + 1)
      } else if (/-Info\.plist$/.test(ent.name)) {
        out.push(full)
      }
    }
  }
  walk(platformRoot, 0)
  return out
}

module.exports = function (ctx) {
  const platforms = (ctx.opts && ctx.opts.platforms) || []
  if (platforms.length && platforms.indexOf('ios') === -1) {
    return Promise.resolve()
  }

  const projectRoot = (ctx.opts && ctx.opts.projectRoot) || path.resolve('.')
  const platformRoot = path.join(projectRoot, 'platforms', 'ios')
  if (!fs.existsSync(platformRoot)) {
    console.log('[ios-plist-patch] 未找到 platforms/ios，跳过（platform add ios 之后才会生效）')
    return Promise.resolve()
  }

  const plists = findInfoPlists(platformRoot)
  if (!plists.length) {
    console.warn('[ios-plist-patch] 未找到 *-Info.plist，跳过')
    return Promise.resolve()
  }

  for (const file of plists) {
    let xml
    try {
      xml = fs.readFileSync(file, 'utf8')
    } catch (e) {
      console.error('[ios-plist-patch] 读取失败 ' + file + ': ' + e.message)
      continue
    }
    const before = xml
    const applied = []

    for (const entry of ENTRIES) {
      const hasKey = xml.indexOf('<key>' + entry.key + '</key>') !== -1

      if (!hasKey) {
        const next = insertBeforeRootClose(xml, entry.xml)
        if (next) { xml = next; applied.push(entry.key + '(新增)') }
        else console.warn('[ios-plist-patch] ' + file + ' 结构异常，未能插入 ' + entry.key)
        continue
      }

      if (entry.mergeArray) {
        const next = mergeArrayValue(xml, entry.key, entry.mergeArray)
        if (next && next !== xml) { xml = next; applied.push(entry.key + '(合并 ' + entry.mergeArray + ')') }
        continue
      }

      if (entry.replace) {
        const next = replaceValue(xml, entry.key, entry.xml)
        if (next && next !== xml) { xml = next; applied.push(entry.key + '(更新)') }
      }
    }

    if (xml !== before) {
      try {
        fs.writeFileSync(file, xml, 'utf8')
        console.log('[ios-plist-patch] ' + path.relative(projectRoot, file) + ' -> ' + applied.join(', '))
      } catch (e) {
        console.error('[ios-plist-patch] 写入失败 ' + file + ': ' + e.message)
      }
    } else {
      console.log('[ios-plist-patch] ' + path.relative(projectRoot, file) + ' 无需改动（已幂等）')
    }
  }

  return Promise.resolve()
}
