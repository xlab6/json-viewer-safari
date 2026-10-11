# JSON Viewer for Safari

[English](README.md) | [简体中文](README.zh-CN.md)

[![下载 DMG](https://img.shields.io/github/v/release/xlab6/json-viewer-safari?style=for-the-badge&label=%E4%B8%8B%E8%BD%BD%20DMG&color=blue)](https://github.com/xlab6/json-viewer-safari/releases/latest/download/JSON-Viewer.dmg)

自动识别 JSON 页面并格式化输出的 Safari Web Extension。

需要 macOS + Xcode；Node ≥ 18 仅用于测试与图标脚本。

## 截图

![扩展接管 api.github.com/feeds 后的格式化效果](docs/screenshot.png)

## 功能

- **自动接管 JSON 页面**：`Content-Type` 为 JSON，或正文是单个 `<pre>` / 纯文本的 JSON；
  真实 HTML 页面一律不碰，> 8 MB 不接管
- **格式化展示**：语法高亮 + 行号
- **链接**：字符串里的 URL 平时与普通字符串无异，按住 ⌘/Ctrl 悬停才显形、点击新标签打开；
  普通点击不跳走；顶栏网址点击可复制全文
- **等宽字体自选**：下拉列出系统安装的全部等宽字体
- **主题**：自动跟随系统明暗 / 暗 / 亮，持久化
- **顶栏**：请求网址（超长中间省略）+ 渲染时间戳 + 大小 · 行数 · 键数 · 深度（嵌套层级，根为 1）
- **回顶按钮**：滚动超过 300px 后在右下角出现
- **复制 / 下载 .json**；解析失败时显示错误原因与原文

## 快速开始

### 在 Safari 中运行

1. Xcode 打开 `xcode/JSON Viewer/JSON Viewer.xcodeproj`，两个 target 保持 **Sign to Run Locally**
2. `Cmd+R` 运行，欢迎窗会显示当前版本与仓库地址
3. Safari → **设置 → 扩展**：勾选 *JSON Viewer*，网站访问权限设为**所有网站**
4. 打开任意 JSON 链接；本地文件可起个静态服务：

```bash
python3 -m http.server 8000
# Safari 打开 http://localhost:8000/demo/sample.json
```

### 命令行构建

```bash
cd "xcode/JSON Viewer"
xcodebuild -project "JSON Viewer.xcodeproj" -scheme "JSON Viewer" -configuration Debug build
```

## 开发与测试

```bash
npm install      # 仅 jsdom
npm run check    # JS 语法 + manifest 校验
npm test         # 冒烟测试（150 项断言）
npm run icons    # 换 logo 后重生成全部图标
```

测试覆盖：接管边界（含不劫持真实网页的反例）、渲染/行号/高亮、链接与点击策略、
字体两条通道、主题跟随、顶栏/回顶、清单与版本同步契约。

## 项目结构

```
json-viewer-safari/
├── extension/               # 扩展本体（Xcode 工程直接引用此目录，改完 Cmd+R 生效）
│   ├── manifest.json        # MV2，storage + nativeMessaging，中英双语描述
│   ├── content.js           # 检测、渲染、字体、主题、链接、回顶
│   ├── styles.css           # 明暗主题与行号样式
│   ├── background.js        # 原生消息转发
│   └── icons/               # 由 logo 源图生成
├── scripts/
│   ├── logo-source.png      # logo 源图
│   ├── build-icons.swift    # 抠底 + 裁剪 + 全尺寸生成（npm run icons）
│   └── lint-manifest.js
├── tests/smoke.mjs          # 冒烟测试（150 项断言）
├── demo/preview.html        # 预览页
├── demo/sample.json
└── xcode/JSON Viewer/       # safari-web-extension-converter 生成的工程
```

## Xcode 工程

工程**未使用** `--copy-resources`，直接引用 `extension/` 源文件，改完 `Cmd+R` 即生效。
重新生成工程：

```bash
xcrun safari-web-extension-converter ./extension \
  --project-location ./xcode --app-name "JSON Viewer" \
  --bundle-identifier cn.oxzz.json-viewer \
  --swift --macos-only --no-open --no-prompt --force
```

> 生成后检查 `PRODUCT_BUNDLE_IDENTIFIER`：app 必须是 `cn.oxzz.json-viewer`、
> 扩展是 `cn.oxzz.json-viewer.Extension`，否则报
> `Embedded binary's bundle identifier is not prefixed` 构建失败；
> 另外确认 manifest 保留 `nativeMessaging` 权限，否则字体枚举失效。

## 仓库

```bash
git clone git@github.com:xlab6/json-viewer-safari.git
```

默认分支 `main`。