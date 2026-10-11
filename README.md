# JSON Viewer for Safari

自动识别 JSON 页面并**格式化输出**的 Safari Web Extension，参考 Chrome 商店的
[JSON Viewer](https://chromewebstore.google.com/detail/json-viewer/gbdbademeighmnbliehmnoifmabbedbp)。

**环境要求**：macOS + Xcode（工程在 Xcode 27 下验证通过）；Node ≥ 18（仅用于测试与图标脚本调用）。

## 目录

- [功能](#功能)
- [安全边界](#安全边界)
- [快速开始](#快速开始)
- [开发与测试](#开发与测试)
- [项目结构](#项目结构)
- [架构与实现](#架构与实现)
- [扩展源码与 Xcode 工程](#扩展源码与-xcode-工程)
- [manifest 设计](#manifest-设计)
- [常见问题](#常见问题)
- [仓库](#仓库)
- [与参考扩展的功能对照](#与参考扩展的功能对照)
- [版本记录](#版本记录)

## 功能

- **自动检测**：`Content-Type` 含 `json`，或正文是纯 JSON（单个 `<pre>` / 纯文本）时自动接管页面
- **单一展示模式**：pretty 打印 + 语法高亮 + **左侧行号**（40px 数字列、无分隔竖线，对齐参考截图）
- **链接可点击（平时隐形）**：字符串值里的 URL（http/https/ftp/mailto，含句中链接）会成为链接，
  但**平时与普通字符串完全一致**——无下划线、无手型光标、无 tooltip；
  **按住 ⌘ / Ctrl 时，鼠标所在的那一个链接**才高亮并显示手型，此时点击在新标签页打开；
  普通点击始终不跳走（保护正在查看的文档）
- **等宽字体自选**：下拉列表由**原生端 CoreText 实时枚举系统全部等宽字体**
  （本机实测 30 个：Menlo / Monaco / Fira Code / Hack / Cascadia…），
  页面内 canvas 探测作为兜底，选择经 `storage.local` 持久化
- **主题**：自动（实时跟随系统明暗切换）/ 暗色 / 亮色三态，`storage.local` 持久化
- **顶栏信息**（两行堆叠、整块垂直居中）：
  上行为**请求网址**——超长时中间省略，头部（协议+域名+路径开头）与尾部（query 结尾）都保留，
  悬停 tooltip 恒为完整 URL、**点击复制全文**；
  下行为**渲染时间戳**（`YYYY-MM-DD HH:mm:ss`）+ 统计（大小 · 行数 · 键数 · 深度）
- **隐藏滚动条**：滚动条完全隐藏，滚轮 / 触控板 / 键盘滚动照常
- **回顶按钮**：滚动超过 300px 后右下角淡入 `↑`，点击平滑回到顶部并立即隐藏
  （滚动条既已隐藏，它同时充当滚动位置指示）
- **复制**、**下载 .json**
- **行高固定 1.8**：正文、行块最小高度与行号对齐由 `--jv-lh` 单点驱动
- **错误页**：`application/json` 但解析失败时显示错误原因 + 原文
- 超大文件保护：> 8 MB 不接管；> 1.5 MB 不高亮；> 20000 行不显示行号（降级纯文本）
- **中英双语描述**：manifest `description` 中英并列，Safari 扩展设置里可读

## 安全边界

| 保护 | 说明 |
| --- | --- |
| 结构判定 | 仅当页面是「单个 `<pre>`（无子元素）或纯文本」或 `Content-Type` 为 JSON 时接管；含 `<div>` 等真实 DOM 的页面一律跳过 |
| 体积上限 | 正文 > 8 MB 不解析、不接管 |
| 内容上限 | 超长文本自动降级：关高亮、去行号，保证大文件可读 |
| 交互优先 | 手动点击、回顶等用户操作永远优先于自动行为 |

## 快速开始

### 免安装预览（推荐先看这个）

```bash
open demo/preview.html        # 或用任意浏览器打开该文件
```

预览页加载与扩展**完全相同**的 `styles.css` + `content.js`，由它接管 `<pre>` 中的 JSON——
行号、换字体、切系统明暗、⌘ 按下显形链接、回顶按钮都在这里可验证。
（预览页没有原生通道，字体列表走 canvas 探测兜底。）

### 在 Safari 中运行

1. 用 Xcode 打开 `xcode/JSON Viewer/JSON Viewer.xcodeproj`
2. 两个 target 都保持 **Sign to Run Locally**（本地调试无需开发者账号；上架时再选 Team）
3. `Cmd+R` 运行，会自动启动 `JSON Viewer.app` —— 欢迎窗显示**当前版本**与**仓库地址**
   （点击地址在默认浏览器中打开）
4. Safari → **设置 → 扩展**：勾选 *JSON Viewer*，并把「网站访问权限」设为**所有网站**
5. 打开任意返回 JSON 的链接体验；本地文件可在项目目录起个静态服务：

```bash
python3 -m http.server 8000
# Safari 打开 http://localhost:8000/demo/sample.json
```

命令行构建（已在本机验证 `BUILD SUCCEEDED`，产物 ad-hoc 签名）：

```bash
cd "xcode/JSON Viewer"
xcodebuild -project "JSON Viewer.xcodeproj" -scheme "JSON Viewer" -configuration Debug build
```

## 开发与测试

```bash
npm install      # 仅 devDependencies：jsdom
npm run check    # JS 语法检查 + manifest 校验（nativeMessaging / 无死按钮）
npm test         # jsdom 冒烟测试（145 项断言）
npm run icons    # 抠底 + 裁剪 + 重生成全部图标（extension 6 个 + AppIcon 10 个 + 欢迎页 1 个）
```

测试覆盖：接管判定（含**不劫持真实网页**的反例）、单一模式与逐行行号、
高亮 token、**链接识别与点击策略**（纯值 / 句中 URL、href 与 query 保真、
普通点击拦截、⌘+Click 放行、平时无 tooltip/无状态类、悬停效果以 ⌘ 状态为门槛）、
顶栏（`{ }` 占位与文件名移除、**URL 在上 / 时间戳在下的两行堆叠**、时间戳格式、
短网址原样 / **长网址中间省略首尾保留、tooltip 全文、点击复制**）、
回顶按钮（出现阈值 / 点击平滑回顶 / 立即隐藏）、
字体两条通道（原生转发链路 + canvas 探测的安装/等宽双重校验）、
background 转发协议（路由、action、原生失败降级）、系统暗黑实时跟随与显式主题优先、
错误页原文渲染、数组根节点、样式表/清单契约。

## 项目结构

```
json-viewer-safari/
├── extension/               # Web 扩展本体（Xcode 工程直接引用该目录）
│   ├── manifest.json        # MV2 清单：storage + nativeMessaging，中英双语描述
│   ├── content.js           # 核心：检测 / 高亮渲染 / 链接 / 字体 / 主题 / 回顶
│   ├── styles.css           # 明暗双主题 + 行号 gutter（CSS counter）
│   ├── background.js        # 原生消息转发（content 不能直连原生）
│   └── icons/               # 由 logo 源图生成的 PNG（带透明度自检）
├── scripts/
│   ├── logo-source.png      # logo 源图（1000×990，透明底）
│   ├── build-icons.swift    # 抠底 + 裁剪 + 全尺寸生成（纯 Swift，无第三方包）
│   └── lint-manifest.js     # 清单与引用文件校验
├── tests/smoke.mjs          # jsdom 冒烟测试（145 项断言）
├── demo/
│   ├── preview.html         # 免安装 UI 预览（任意浏览器直接打开）
│   └── sample.json          # 本地体验用示例
├── xcode/JSON Viewer/       # safari-web-extension-converter 生成的工程
│   └── JSON Viewer Extension/
│       └── SafariWebExtensionHandler.swift   # CoreText 枚举系统等宽字体
├── package.json
└── README.md
```

## 架构与实现

### 字体列表是怎么来的

Safari 的 Web 扩展与原生代码之间有三层，各司其职：

```
content.js --runtime.sendMessage--> background.js --sendNativeMessage-->
SafariWebExtensionHandler (Swift / CoreText) --> 系统全部等宽字体
```

- Apple 限制：**注入网页的 content script 不能直接调 `sendNativeMessage`**，
  因此由 background 页转发（`manifest.permissions` 需要 `nativeMessaging`）
- Swift 端枚举 `CTFontManagerCopyAvailableFontFamilyNames()` 的全部字体族，
  用「`i`/`m`/`W`/`A`/`0`/`a` 六个字符等宽」判定是否等宽，剔除 Wingdings 等假阳性；
  默认面等宽 → 给族名，族内单独等宽面 → 给 PostScript 名（如 `Osaka-Mono`）
- 独立预览页（`preview.html` / 无扩展环境）没有原生通道，自动降级为
  **canvas 探测**：与「故意不存在的字体」比对宽度 + `i==W` 复核
- 两条通道合并去重、按字母排序，「Default font」恒在首位

### 实现要点

- **行号**：CSS counter（`counter-reset` 在 `.jv-pre`、`counter-increment` 在每个 `.jv-ln`），
  数字列 40px 右对齐、内容从 46px 开始、**无分隔线**；每行一个块级元素，
  超大文件（> 20000 行）自动降级为无行号纯文本块
- **语法高亮**：单遍扫描器区分 key/string/number/bool/null/punc，HTML 转义后拼接，
  跨行分割安全（换行符不在任何 span 内）
- **链接**：仅**值**参与链接化（key 保持普通文本）；scheme 快筛后用 `JSON.parse` 解码得到
  干净 href（无 \\/ 等 JSON 转义），提取 URL 并剔除尾随句读；`target="_blank" rel="noopener"`，
  点击时只有带修饰键（⌘/Ctrl/Shift/Alt）才放行，普通点击 `preventDefault` 原地保留。
  隐形化：`color: inherit` + `text-decoration: none` + `cursor: default`，且**不输出 title**
  （tooltip 会暴露链接）；`cursor: pointer` 与 `hover` 高亮全部挂在 `.is-cmd` 选择器下，
  因此只有「⌘ 按下 × 鼠标悬停」这一种状态会显形
- **主题**：暗色变量键在 `html.jv-html[data-theme]`，JS 同时写 `documentElement` 与 `.jv-root`，
  并监听 `matchMedia('(prefers-color-scheme: dark)')` 的 change 事件实时跟随
- **行高**：`--jv-lh: 1.8` 声明在基础主题块，`.jv-root` / `.jv-pre` / `.jv-ln` 与行号
  `.jv-ln::before` 全部引用它 —— 单点控制，行号始终与首行文字对齐
- **长网址**：`shortenUrl()` 超过 72 字符时输出「头 42 + `…` + 尾 24」（域名与 query 尾都在视野内）；
  CSS 再套 `max-width + ellipsis` 做窄屏兜底、`min-width: 8ch` 防止被挤成看不见的一条；
  tooltip 恒为完整 URL，点击走 `copyToClipboard()` 复制全文
- **滚动条与回顶**：`scrollbar-width: none` + WebKit `display:none` 双写隐藏滚动条（滚动能力保留）；
  回顶按钮 `scrollY > 300` 时淡入，点击 `behavior: 'smooth'` 回顶并立即隐藏

### 图标管线

`scripts/logo-source.png`（1000×990 透明底）由 `build-icons.swift` 处理：

1. 缓冲区以**透明**初始化（避免 source-over 把透明角合成白底 —— 这是踩过的坑）
2. 从四边泛洪填充剔除白底（纸张、罗盘环等**内部白色因连通性受保护**）
3. 对边缘抗锯齿像素按「`alpha = 255 - min(RGB)`、预乘 = `RGB - min(RGB)`」反混合去白边
4. 裁剪后输出三处图标：extension 六个尺寸（满幅，随 `.appex` 打包）、
   AppIcon 十个尺寸（7% 留白，编译进 `AppIcon.icns`）、
   容器 App 欢迎页的 `Resources/Icon.png`（128px，7% 留白）
5. 结尾自检 `corner alpha = 0`，透明度丢失直接构建失败

换 logo 只需替换源图后执行 `npm run icons`。

## 扩展源码与 Xcode 工程

转换时**未使用** `--copy-resources`，工程通过 `../../../extension/...` 直接引用源文件：
改完 `extension/` 下的 JS/CSS 后重新 `Cmd+R` 即生效，无需重新转换。

如需重新生成工程：

```bash
xcrun safari-web-extension-converter ./extension \
  --project-location ./xcode \
  --app-name "JSON Viewer" \
  --bundle-identifier cn.oxzz.json-viewer \
  --swift --macos-only --no-open --no-prompt --force
```

> **坑（务必检查）**：转换器会按应用名派生 app 的 `PRODUCT_BUNDLE_IDENTIFIER`（如 `cn.oxzz.JSON-Viewer`），
> 与扩展的 `cn.oxzz.json-viewer.Extension` 前缀不一致会导致
> `Embedded binary's bundle identifier is not prefixed` 构建失败。
> 本工程已统一为：app = `cn.oxzz.json-viewer`，扩展 = `cn.oxzz.json-viewer.Extension`。
> 重新生成后记得在 manifest 中保留 `nativeMessaging` 权限，否则字体枚举失效。

## manifest 设计

- `manifest_version: 2`：Safari 对 MV2 支持最稳定，且不依赖 `background.service_worker`
- `permissions: ["storage", "nativeMessaging"]`：主题/字体持久化 + 原生字体枚举
- `background.scripts`：仅做原生消息转发（无工具栏按钮——展示只有一种模式）
- `content_scripts`：`run_at: document_start` + 同时注入 `styles.css`，避免原始 JSON 闪屏
- `description`：中英双语并列，Safari 扩展设置页可直接读懂

## 常见问题

**打开本地 `file://xxx.json` 没有格式化？**
Safari 默认不给扩展本地文件访问——在「设置 → 扩展 → JSON Viewer」把网站访问权限设为**所有网站**；
或按[快速开始](#快速开始)用 `python3 -m http.server` 起服务访问。

**字体下拉里只有 Default font？**
原生枚举依赖扩展已启用（无需保持 App 打开）；`preview.html` 在无扩展环境下走 canvas 探测，
只会列出 canvas 能探测到的字体——完整列表请在 Safari 里跑扩展查看。

**改了代码，Safari 里看到的还是旧的？**
Xcode `Cmd+R` 重新 Run（工程引用的是 `extension/` 源文件）；若欢迎窗/图标还是旧图，
退出 App 再启动（运行中的窗口缓存了旧资源）。

**Bundle ID 前缀不一致构建失败？**
见[扩展源码与 Xcode 工程](#扩展源码与-xcode-工程)中的「坑」。

**换自己的 logo？**
替换 `scripts/logo-source.png` → `npm run icons` → `Cmd+R`，三处图标（扩展 / AppIcon / 欢迎页）同时更新。

## 仓库

```bash
git clone git@github.com:xlab6/json-viewer-safari.git
cd json-viewer-safari
```

默认分支 `main`。

## 与参考扩展的功能对照

| 能力 | 本扩展 |
| --- | --- |
| 格式化展示 + 语法高亮 | ✅ 单一模式（对应参考截图的观感） |
| 行号 | ✅ CSS counter 自动编号，无分隔竖线 |
| 自定义等宽字体 | ✅ **原生枚举系统全部等宽字体**（本机 30 个），canvas 兜底 |
| 明暗主题 | ✅ 自动（实时跟随系统）/ 暗 / 亮三态并持久化 |
| 链接点击 | ✅ 平时与普通字符串无异；⌘ 按下时悬停的那个链接显形，⌘+Click 新标签打开 |
| 复制 / 下载 | ✅ |
| 统计信息 | ✅ 大小 · 行数 · 键数 · 深度 |
| 错误提示 | ✅ 解析失败给出原因 |
| 回顶 / 隐藏滚动条 | ✅ |
| Safari 原生工程 | ✅ 已生成并编译通过（含 CoreText 原生端） |

## 版本记录

### 1.1.0（当前）

- 切换为**单一展示模式**（移除树形/搜索/展开折叠按钮），行号按参考截图样式实现
- **原生 CoreText 枚举系统等宽字体**（background 转发 + canvas 兜底）
- 顶栏改为两行：请求网址（长网址中间省略 + 点击复制）+ 时间戳与统计
- 链接改为 ⌘ 按下才显形、⌘+Click 打开；行高固定 1.8；隐藏滚动条 + 回顶按钮
- manifest 描述中英双语；新 logo 替换全部 17 处图标并加透明度自检
- 欢迎窗（App 界面）显示版本徽章与 GitHub 地址，版本号四处与 manifest 对齐并有契约测试

### 1.0.0

- 初始版本：树形视图 + 搜索 + 展开/折叠、明暗主题、字体选择、复制下载
- 生成 Xcode 工程（safari-web-extension-converter）并编译通过
