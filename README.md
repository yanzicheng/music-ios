# MusicPlayer-iOS — 音乐 App 的 iOS 移植工程

把安卓版「音乐」(`com.chengying.music`, 3.23) 原样搬到 iOS 的 Cordova 外壳工程。

- **前端**：安卓版 `ui-mobile/` 全量复制（同一套 HTML/CSS/JS，界面与原 App 一致）
- **后端**：安卓版 `app/server/` + `音源/` 全量复制，由 **nodejs-mobile** 在 App 进程内跑起来
- **构建**：GitHub Actions（macOS 云端）出包，本地不需要 Mac

> 本仓库只有**源码**，`platforms/`、`plugins/`、`node_modules/` 全部由 CI 生成，不入库。

---

## 1. 目录结构

```
MusicPlayer-iOS/
├── config.xml                     # Cordova 应用配置（名称/包名/竖屏/图标/ATS hook）
├── package.json                   # cordova-ios 7.1.1 + @red-mobile/nodejs-mobile-cordova 3.4.2
├── www/                           # ← 由安卓 ui-mobile/ 全量复制，改动请回原工程同步
│   ├── index.html                 #    仅比原版多 3 行 <script>（见 §5）
│   ├── css/  img/                 #    原样
│   ├── js/
│   │   ├── api.js                 #    原版，未改动
│   │   ├── app.js / player.js / audiofx.js
│   │   ├── api-base.js            # ★ iOS 新增：基址优先探测 127.0.0.1:34200
│   │   └── index.js               # ★ iOS 新增：Cordova 入口，启动内嵌 Node
│   └── nodejs-project/            # ★ 内嵌 Node 工程（插件从这里取）
│       ├── main.js                #    启动入口：注入环境变量后 require('./server/index.js')
│       ├── package.json
│       ├── server/                # ← 由安卓 app/server/ 全量复制（13 个文件，零第三方依赖）
│       └── 音源/                   # ← 由安卓 音源/ 全量复制（8 个洛雪脚本）
├── res/
│   ├── icon/ios/                  # 11 个尺寸图标（占位图，可替换）
│   └── screen/ios/                # 启动图占位
├── hooks/
│   └── ios-plist-patch.js         # after_prepare：给 Info.plist 补 ATS / 后台音频 / 文件共享 / 竖屏
├── ios/
│   ├── Info.plist.fragment.plist  # 同一份 plist 改动的静态参考（手工改工程时用）
│   └── AppDelegate-audio-session.md # 后台播放所需的一小段原生代码（可选步骤）
└── .github/workflows/ios-build.yml
```

---

## 2. 技术路线（为什么不是 Swift 重写）

安卓原版的架构是：`Java 壳 + WebView(http://app.local) + NodeService(进程内跑 libnode.so)`，
业务逻辑（13 个 Node 文件 + 8 个音源脚本，零第三方依赖）与前端全部与平台无关。
因此 iOS 侧只需要一个等价容器：

| 安卓 | iOS 对应 |
|---|---|
| `WebView` 加载 `ui-mobile` | `WKWebView` 加载 `www/index.html`（Cordova） |
| `NodeService` + `libnode.so`（nodejs-mobile 18.20.4） | `NodeMobile.framework`（nodejs-mobile-cordova 插件） |
| `main.js` 注入 `LX_ROOT/LX_HOST/LX_PORT` | `www/nodejs-project/main.js`，同一套环境变量 |
| 数据写在 `/data/data/.../files` | 数据写在沙盒 `Documents/MusicPlayerData`（Bundle 只读，必须改） |
| `AndroidManifest` 竖屏 + `foregroundServiceType=mediaPlayback` | `UISupportedInterfaceOrientations` + `UIBackgroundModes=audio` |

音源、音质、接口协议全部原样保留，**没有重写任何业务代码**。

---

## 3. 本地构建（有 Mac 才需要，没 Mac 直接看 §6 用 Actions）

前置：Xcode 15+、CocoaPods、Node.js 18（cordova-ios 7.1.1 要求 Node ≥ 16.13；cordova 12 需要 Node ≥ 18，**不要用 Node 20+ 的 cordova 13 组合**，与插件兼容性未验证）。

```bash
npm install
npx cordova platform add ios
npx cordova plugin add @red-mobile/nodejs-mobile-cordova
npx cordova prepare ios          # 同步 www → platforms/ios/www，并触发 plist hook
npx cordova build ios --release --device --no-sign
```

产物位置：`platforms/ios/build/Release-iphoneos/MusicPlayer.app`
（要出 ipa：把它放进 `Payload/` 目录后 `zip -r app.ipa Payload`）。

`cordova prepare` 之后可以检查 plist 是否被正确补齐：

```bash
grep -A3 -E "NSAppTransportSecurity|UIBackgroundModes" platforms/ios/*/MusicPlayer-Info.plist
```

---

## 4. 改源码的标准流程

**本仓库是拷贝，不是源工程。** 真正要长期维护的目录是 `D:\学习\音乐`：

| 改什么 | 在源工程改 | 然后同步到本仓库 |
|---|---|---|
| 界面 / 交互 / 样式 | `ui-mobile/**` | 复制覆盖 `www/`（**不要覆盖 `www/js/index.js`、`www/js/api-base.js`、`www/nodejs-project/`**） |
| 接口 / 音源逻辑 | `app/server/**` | 复制覆盖 `www/nodejs-project/server/` |
| 音源脚本 | `音源/*.js` | 复制覆盖 `www/nodejs-project/音源/` |
| 应用名 / 版本号 / 图标 | — | 改 `config.xml` 的 `version`；图标换 `res/icon/ios/*.png`（保持同名同尺寸） |

覆盖 `www/index.html` 之后，**必须重新补上这 3 行**（在原版 `<script src="js/api.js">` 之前/之后）：

```html
<script src="cordova.js"></script>                 <!-- 放在 js/api.js 之前 -->
<script src="js/api-base.js"></script>             <!-- 放在 js/api.js 之前 -->
...
<script src="js/index.js"></script>                <!-- 放在 js/app.js 之后、</body> 之前 -->
```

改完推 GitHub，Actions 自动重新出包。

---

## 5. 已做的 4 处 iOS 适配（与原版的唯一差异）

### 5.1 `www/nodejs-project/main.js`（新增，替代安卓的 main.js）
在 `require('./server/index.js')` 之前注入：

| 环境变量 | 值 | 作用 |
|---|---|---|
| `LX_ROOT` | `Documents/MusicPlayerData` | 数据/下载/缓存/日志根目录，**避开只读 Bundle** |
| `LX_HOST` / `LX_PORT` | `127.0.0.1` / `34200` | 仅回环监听，与原版端口一致 |
| `LX_MOBILE_DIR` | 自动探测 `www` | 服务端静态托管的前端目录 |
| `LX_SRC_DIR` | `音源/`（兼容 `sources/`） | 音源脚本目录 |

另外处理：预建 `缓存/日志/下载/数据/tmp` 子目录、`chdir` 到可写目录、端口占用轮询等待、`uncaughtException` 上报、`cordova.app.on('pause')` 里调用 **`pauseLock.release()`**（不释放会被 iOS 看门狗杀进程）。

### 5.2 `www/js/index.js`（新增，Cordova 入口）
`deviceready` → `nodejs.start('main.js')`，失败重试 3 次，错误以顶部浮层显示在页面上，
并把内嵌 Node 的日志接到 Xcode 控制台。

### 5.3 `www/js/api-base.js`（新增，基址探测改造）
- 在 `api.js` **之前**加载，若前端还没有明确基址来源，就**同步**写入 `window.__API_BASE__ = 'http://127.0.0.1:34200'`。
  因为 `api.js` 的 `FALLBACK_CANDIDATES` 里 `http://10.0.2.2:34200` 排在第一位，iOS 上它永远打不通，
  不做这一步每次首屏都要先白等 3.5 秒探测超时，之后才轮到 `127.0.0.1`
- 之后用 `/api/health` 做确认探测（超时 2 秒，间隔 0.5 秒，最多 12 轮 ≈ 6 秒），成功只打一行日志
- **不覆盖**构建注入的 `__API_BASE__`（安卓打包时的 `--api-base`）与 localStorage 里用户手填的基址（键 `lx.apiBase`），两者只要有一个存在就完全不动
- 顺手清掉 localStorage 里安卓模拟器遗留的 `http://10.0.2.2:34200`
- 音频流 `/api/proxy` 与封面代理走同一基址，天然同源，不受影响

### 5.4 `hooks/ios-plist-patch.js`（新增，after_prepare）
每次 `cordova prepare` 幂等写入 Info.plist：

| 键 | 值 | 原因 |
|---|---|---|
| `CFBundleDisplayName` | 音乐 | widget name 保持 ASCII，工程名/scheme 稳定 |
| `NSAppTransportSecurity` | AllowArbitraryLoads + LocalNetworking + localhost/127.0.0.1 例外 | WebView 要访问 `http://127.0.0.1:34200` |
| `UIBackgroundModes` | `audio` | 切后台/锁屏继续播放 |
| `UIFileSharingEnabled` / `LSSupportsOpeningDocumentsInPlace` | true | 「文件」App 里能看到文档目录，方便塞本地歌曲 |
| `UISupportedInterfaceOrientations` | 仅 Portrait | 对齐安卓的 `screenOrientation=portrait` |
| `ITSAppUsesNonExemptEncryption` | false | 只用系统 HTTPS |

---

## 6. 上传 GitHub 并用 Actions 出包

```bash
cd MusicPlayer-iOS
git init
git add .
git commit -m "init: iOS port of music player"
git branch -M main
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git push -u origin main
```

**触发方式**
1. 推送代码到 `main`（改了 `*.md` 之外的文件自动触发）
2. 仓库 Actions 页面 → `iOS Build` → `Run workflow` 手动触发

**产物（Actions 运行结束 → 页面底部 Artifacts）**

| Artifact | 内容 | 用途 |
|---|---|---|
| `MusicPlayer-unsigned.zip` | 未签名 `MusicPlayer.app` | 用 Sideloadly 自签安装（§7） |
| `MusicPlayer-ipa` | 已签名 `MusicPlayer-signed.ipa` | 仅当配置了签名 secret 才会生成 |
| `build-log` | 编译日志 | 编译失败时先看这个 |

`build-unsigned` 这个 job **不需要任何 Apple 账号**，任何人 fork 都能跑。

---

## 7. 自签安装（Sideloadly / 7 天重签）

### 方案 A：完全不碰证书（推荐先跑通这个）
1. 下载 `MusicPlayer-unsigned.zip`，解压得到 `MusicPlayer.app`
2. 把 `.app` 拖进 Sideloadly（Windows 版即可），登录自己的 Apple ID（免费账号也行）
3. Sideloadly 会自动完成签名 + 安装到已信任的 iPhone
4. 首次启动若提示「不受信任的开发者」：设置 → 通用 → VPN与设备管理 → 信任你的 Apple ID

### 方案 B：CI 直接出 ipa（需要付费开发者账号才有稳定 7 天以上有效期）
在仓库 Settings → Secrets and variables → Actions 添加：

| Secret | 获取方式 |
|---|---|
| `P12_BASE64` | 钥匙串导出 `.p12` 后：`base64 -i cert.p12 \| pbcopy`（macOS）；Windows 用 `certutil -encode` 或 Git Bash 的 `base64 -w0` |
| `P12_PASSWORD` | 导出 p12 时设置的密码 |
| `MOBILEPROVISION_BASE64` | 描述文件 `.mobileprovision` 同样 base64 |

要求：**profile 的 App ID 必须是 `com.chengying.music.ios`**（或改 `config.xml` 的 `widget id` 与之匹配），
且设备 UDID 已加入该 profile（ad-hoc）。配置好后再跑一次 workflow，`sign-ipa` job 会产出 `MusicPlayer-signed.ipa`（用 AltStore / Sideloadly 安装，或用 Xcode Devices 拖入）。

### 免费账号 7 天限制
- 免费 Apple ID 签名有效期 **7 天**，到期 App 闪退打不开，需**用同一台电脑重复 Sideloadly 重签**（再次拖入同一个 `.app` 即可），数据（歌单/配置）保留
- 换电脑重签也可以，但要重新信任证书
- 想免重签：付费开发者账号（1 年）+ ad-hoc，或用 AltStore 的自动重签（需电脑/服务端常开）

---

## 8. 已知限制与首次运行要验证的点

1. **后台播放**：`UIBackgroundModes=audio` 已加，但 WKWebView 的默认音频类别是 `ambient`，
   锁屏后可能被静音/暂停。要彻底解决需在 `AppDelegate.m` 里设置
   `AVAudioSession` 类别为 `playback`，代码片段见 `ios/AppDelegate-audio-session.md`（可选步骤，需改平台工程或写成 hook）。
2. **静音键**：同上，类别为 `playback` 后才会忽略静音开关。
3. **下载目录**：服务端下载写入 `Documents/MusicPlayerData/下载`，通过「文件」App 可见（已开 UIFileSharing）。
4. **音源可用性**：8 个音源脚本原样搬运，但部分脚本内部若硬编码了 `10.0.2.2`、安卓 UA 或 `Android` 判断，需逐个在真机验证；
   这类脚本是外部来源，本仓库不修改其内部实现。
5. **首次冷启动**：Node 内核初始化 + 8 个音源脚本加载约 1~3 秒，`api.js` 有 18 秒轮询，属正常；期间页面显示加载中。
6. **未包含的插件**：状态栏、媒体控制中心（`MPNowPlayingInfoCenter`）都需要额外插件；当前界面内播放正常，
   但锁屏控制中心不会显示歌曲信息（`player.js` 用的是 `mediaSession`，iOS 支持已较好，真机需确认）。
7. **图标是占位图**（音符 + 绿圈），替换 `res/icon/ios/` 下同名文件即可，注意 1024 那张**不能带透明通道**。

---

## 9. 排障速查

| 现象 | 排查 |
|---|---|
| 页面白屏 | 看 `build-log`；本机 Xcode 看控制台里 `[cordova-entry]` / `[main]` 日志 |
| 页面能开但一直"连接失败" | 说明 Node 服务没起来：控制台搜 `[main] 内嵌运行时启动` 是否打印；确认 `www/nodejs-project/server/index.js` 在包里 |
| `内嵌 Node 运行时未注入` | 插件没装/没 prepare：`cordova plugin list` 应含 `@red-mobile/nodejs-mobile-cordova` |
| 音频 404 / 播放失败 | 用 Mac 的 Safari「开发 → 你的 iPhone → 页面」远程调试，看网络面板里请求是否打到 `127.0.0.1:34200/api/proxy`；若是 `10.0.2.2` 说明 api-base.js 没生效 |
| ATS 报错 `App Transport Security` | plist hook 没生效：检查 `<key>NSAppTransportSecurity</key>` 是否写入，确认 hook 在 `config.xml` 里注册 |
| 编译报 `pod install` 失败 | 多为网络；重跑 workflow，或改用 `--buildFlag="-UseModernBuildSystem=YES"` |
| 免费签名 7 天后闪退 | 正常，按 §7 重签 |

---

## 10. 版本

- 应用版本：`1.0.0`（对应安卓 3.23 的功能集合）
- cordova-ios：`7.1.1`（iOS 部署目标 13.0）
- nodejs-mobile（经 `@red-mobile/nodejs-mobile-cordova`）：Node 18 内核，与安卓版 `v18.20.4` 同代
- 前端与后端源码版本：取自 `D:\学习\音乐` 当前工作副本
