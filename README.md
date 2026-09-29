# 2026 网络梗图档案馆

一个收集 2026 年网络热梗的单文件网站。深色高端视觉，左侧热梗滚动墙，右侧需求搜索框，左上角实时天气。

## 特性

- **单文件站点**：`index.html` 内含全部 HTML / CSS / JS，零外部依赖、零 CDN，双击即可打开
- **热梗滚动墙**：左侧双列反向无缝滚动，`translateY(-50%)` 方案，无跳帧
- **中文需求搜索**：整词权重 + 2-3 字滑窗 n-gram + 场景意图词典，中文长句也能命中
- **实时天气**：Open-Meteo 免密钥接口，定位链路为 本地缓存 → 浏览器定位 → IP 定位 → 北京兜底
- **AI 配图**：调用 Replicate flux-schnell 为每个梗生成插画（需本地代理，见下）

## 目录结构

```
index.html        网站本体（唯一必需文件，可直接双击打开）
server.mjs        本地静态服务器 + Replicate 生图代理（零依赖 Node）
.env.example      环境变量模板（复制为 .env 并填入 token）
.gitignore        忽略 .env / generated/ 等敏感与产物目录
generated/        本地生成的 AI 配图（已忽略，不入库）
```

## 本地运行

仅看网站，直接双击 `index.html` 即可 —— 天气和搜索都能用，只有 AI 配图需要代理。

要启用 AI 配图：

```bash
cp .env.example .env        # 然后在 .env 里填 REPLICATE_API_TOKEN
node server.mjs             # 打开 http://127.0.0.1:8788
```

## 关于 API Token

`REPLICATE_API_TOKEN` **只存在于服务端**（`.env`，已被 `.gitignore` 忽略）。
浏览器直连 Replicate 会被 CORS 拦截，因此所有生图请求都经 `server.mjs` 转发，token 永不下发到前端。

> 若 token 曾在任何公开场合（聊天、截图、日志）出现过，请到 Replicate 控制台吊销并重新签发。

## 技术说明

- 天气：Open-Meteo（免密钥、支持 CORS）
- 生图：Replicate `black-forest-labs/flux-schnell`，英文提示词 + 固定风格后缀
- 无构建步骤、无框架、无 npm 依赖
