# 可选步骤：让 iOS 后台播放 / 静音键不生效

## 为什么需要这一步

`config.xml` 里已经加了 `UIBackgroundModes = audio`，允许 App 在后台继续运行；
但 **WKWebView 里 `<audio>` 元素默认使用的 AVAudioSession 类别是 `ambient`**，后果是：

- 拨到静音档 → 播放没声音
- 锁屏 / 切到别的 App → 音频可能被暂停

只有把会话类别设为 `playback`，音频才会像正常音乐 App 一样在后台继续、并忽略静音开关。

> 这一步**没有默认执行**：它会改写 `platforms/ios/**/AppDelegate.m`，属于原生代码改动，
> 风险高于纯 plist 补丁，因此保留为手工/可选步骤。先跑通出包与安装，再决定是否加。

## 做法 A：本地工程手工改（一次性，改完即随构建生效）

打开 `platforms/ios/MusicPlayer/Classes/AppDelegate.m`（cordova-ios 7 的路径，
旧版本是 `platforms/ios/MusicPlayer/Classes/AppDelegate.m` 或 `platforms/ios/音乐/Classes/AppDelegate.m`），在文件顶部：

```objc
#import <AVFoundation/AVFoundation.h>
```

在 `- (BOOL)application:(UIApplication*)application didFinishLaunchingWithOptions:(NSDictionary*)launchOptions`
方法体的**最前面**插入：

```objc
    // 让 WKWebView 内的音频走 playback 类别：支持后台播放、忽略静音开关
    NSError *sessionErr = nil;
    AVAudioSession *session = [AVAudioSession sharedInstance];
    [session setCategory:AVAudioSessionCategoryPlayback
                    mode:AVAudioSessionModeDefault
                 options:AVAudioSessionCategoryOptionMixWithOthers
                   error:&sessionErr];
    if (sessionErr) {
        NSLog(@"[audio-session] 设置类别失败: %@", sessionErr);
    }
    [session setActive:YES error:&sessionErr];
    [[UIApplication sharedApplication] beginReceivingRemoteControlEvents];
```

说明：`MixWithOthers` 让本 App 不打断别的音频；若希望播放时自动暂停其它 App（更接近音乐 App 行为），
把 `options` 改成 `0`。

## 做法 B：写成 hook，让 CI 每次自动打补丁

在本仓库新增 `hooks/ios-appdelegate-audio-session.js`，并在 `config.xml` 里追加：

```xml
<hook type="after_prepare" src="hooks/ios-appdelegate-audio-session.js" />
```

脚本逻辑（与 `ios-plist-patch.js` 同一套路，文本级幂等替换）：

```js
const fs = require('fs')
const path = require('path')

const IMPORT = '#import <AVFoundation/AVFoundation.h>'
const SNIPPET = `
    // [audio-session] WKWebView 音频使用 playback 类别，支持后台播放
    {
        NSError *audioErr = nil;
        AVAudioSession *audioSession = [AVAudioSession sharedInstance];
        [audioSession setCategory:AVAudioSessionCategoryPlayback
                             mode:AVAudioSessionModeDefault
                          options:AVAudioSessionCategoryOptionMixWithOthers
                            error:&audioErr];
        [audioSession setActive:YES error:&audioErr];
        if (audioErr) { NSLog(@"[audio-session] 失败: %@", audioErr); }
        [[UIApplication sharedApplication] beginReceivingRemoteControlEvents];
    }
`

module.exports = function (ctx) {
  const root = path.join(ctx.opts.projectRoot, 'platforms', 'ios')
  const walk = (dir, depth) => {
    if (depth > 4) return []
    let out = []
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'Pods' || ent.name === 'build' || ent.name === 'node_modules') continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) out = out.concat(walk(full, depth + 1))
      else if (ent.name === 'AppDelegate.m') out.push(full)
    }
    return out
  }

  for (const file of walk(root, 0)) {
    let src = fs.readFileSync(file, 'utf8')
    if (src.indexOf('[audio-session]') !== -1) { console.log('[audio-session] 已打过补丁，跳过'); continue }
    const anchor = 'didFinishLaunchingWithOptions:(NSDictionary*)launchOptions\n{'
    const hit = src.indexOf(anchor)
    if (hit === -1) { console.warn('[audio-session] 未找到 didFinishLaunchingWithOptions，跳过 ' + file); continue }
    if (src.indexOf(IMPORT) === -1) src = IMPORT + '\n' + src
    const insertAt = hit + anchor.length
    src = src.slice(0, insertAt) + SNIPPET + src.slice(insertAt)
    fs.writeFileSync(file, src, 'utf8')
    console.log('[audio-session] 已写入 ' + path.relative(ctx.opts.projectRoot, file))
  }
  return Promise.resolve()
}
```

注意：不同 cordova-ios 版本的 `AppDelegate.m` 方法签名**可能不完全一致**（例如
`(NSDictionary*)launchOptions` 前后空格、有无 `UIApplication*)application` 换行差异），
上线前请先本地 `cordova prepare ios` 后打开该文件确认锚点匹配，避免静默跳过。

## 做完怎么验证

1. 播放中按电源键锁屏 → 应在 30 秒后仍在播放
2. 拨静音开关 → 声音应继续（`playback` 类别忽略静音）
3. 通知中心/锁屏的媒体控制：`player.js` 用的是 `mediaSession` API，iOS 15+ 对
   `navigator.mediaSession.metadata` 有基础支持，但封面/按钮是否完整取决于系统版本，
   缺失属已知限制（要完整控制中心需 `MPNowPlayingInfoCenter`，需额外原生插件）。
