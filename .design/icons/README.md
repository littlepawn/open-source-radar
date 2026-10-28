# 开源雷达 · 图标源文件

交付物在 `public/`（`icon.svg` / `favicon-*.png` / `favicon.ico` / `apple-touch-icon.png` /
`icon-192.png` / `icon-512.png` / `manifest.webmanifest`），本目录只放设计过程资产。

| 文件 | 用途 |
|---|---|
| `svg/a-scope.svg` | **当前采用**：双环 + 60° 扫描扇面 + 琥珀回波点 |
| `svg/b-dish.svg` | 备选：三道同心弧锚左下角（易被读成 WiFi，未采用） |
| `svg/c-arc-star.svg` | 备选：雷达弧 + 五角星（语义最全，小尺寸偏挤） |
| `svg/d-bookmark.svg` | 备选：书签 + 衰减波（小尺寸偏碎） |
| `svg/*-16.svg` | 16/24/32px 专用重绘版：加粗笔画、删次级信息，不靠缩放硬压 |
| `preview.png` | 四方案在 256/48/32/24/16 及标签栏、侧栏品牌位上的实景观感 |

换方案：把对应 `svg/<name>.svg` 覆盖为 `public/icon.svg`，并用 Blink 重导 `public/` 下的位图。

设计令牌取自 `public/app.css`：底 `#131417`、主色 `#8ab4f8`、强调 `#e3b341`、文本 `#e8e8ea`。

导图脚本要点（踩过的坑，别再犯）：
- 只在 **`<svg>` 起始标签**里删 `width`/`height`，全局 `replace` 会把 `<rect>` 的宽高一并删掉 → 背景归零、整图变白。
- Chrome headless 截图默认页面底色为不透明白；要透明必须加 `--default-background-color=00000000`。
- **ImageMagick 渲染 SVG 的 `A`（弧）命令会丢整段弧**，矢量化必须走 Blink（Chrome / rsvg），不要用 `magick x.svg`。
