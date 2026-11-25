# ui-mobile（竖屏移动端前端）

仿汽水音乐风格的纯原生移动端前端，无框架、无构建步骤，直接由本地音乐服务的 `/m` 路由托管，
也可整目录塞进 Android WebView / 静态壳中使用。

## 目录

```
ui-mobile/
├── index.html        # 单页骨架：顶部搜索、三页容器、迷你播放条、底部 tab、全屏播放页、各种弹层
├── css/app.css       # 全部样式（安全区、竖屏适配、圆盘/歌词舞台、弹层动画）
├── js/api.js         # 24 个后端接口封装 + 资源代理地址
├── js/player.js      # 播放内核（Audio、队列、歌词、进度、MediaSession）
└── js/app.js         # UI 逻辑（渲染、手势、事件分发）
```

## 接口基址

优先级（`js/api.js`）：

1. `window.__API_BASE__` —— 由原生壳在页面加载前注入，例如
   ```html
   <script>window.__API_BASE__ = 'http://10.0.2.2:34200'</script>
   ```
2. `localStorage.lx.apiBase` —— 「我的 → 接口地址」里手动填写，写入后立即生效；
3. 空字符串 —— 与页面同源（浏览器直接访问 `http://127.0.0.1:34200/m/` 时走这条）。

地址末尾的 `/` 会被自动去掉，拼接时不会出现 `//api/...`。

## 音频播放

`API.mediaUrl()` / `API.proxyUrl()` 保证所有 `http(s)` 资源（音频、封面）都经
`/api/proxy?url=...` 转发，避免音源站的 Referer 校验与跨域限制；服务端代理支持
`Range`，可拖动进度条。

## 后端配合

`app/server/index.js` 已做最小改动：

- `const MOBILE_DIR = path.join(__dirname, '../ui-mobile')`
- `GET /m` → 302 跳 `/m/`；`GET /m/*` → 托管 `ui-mobile`（带 MIME、缓存头、403 越权拦截）
- 响应头补充 `Access-Control-Allow-*` 与 `Access-Control-Expose-Headers`
- `HOST` 支持 `LX_HOST` 环境变量（默认仍是 `127.0.0.1`）；真机通过局域网访问时用
  `LX_HOST=0.0.0.0` 启动

原有 `/`（桌面版 `app/ui`）与全部 `/api/*` 接口行为不变。

## 页面

- **首页**：推荐歌单、排行榜入口、每日推荐列表
- **发现**：榜单矩阵（点击进入榜单详情，支持播放全部）
- **我的**：我喜欢 / 最近播放 / 我的歌单（新建、重命名、删除）、音质、接口地址
- **搜索**：酷我 / QQ 音乐双音源切换、搜索历史（localStorage）
- **全屏播放页**：圆形大封面（播放时缓慢旋转）↔ 歌词，上下滑动切换、歌词自动居中高亮、
  进度条拖动、上一首/下一首/播放暂停、喜欢、音质、收藏到歌单、播放队列
