/* 规则引擎：从仓库元数据推断「中文场景描述」和兜底标签。
   纯函数，无 db / 无网络依赖——抽出来是为了能被 bun test 直接 import。
   注意：规则顺序有意义，越具体的越靠前（见 AGENTS.md「标签规则要按具体度排序」）。 */

export const RULES = [
  // [正则, 中文场景短语, 兜底标签]
  // 裸 slide 会命中 slider（range slider / image slider 这类前端组件），
  // 限定成 slides/slide_show/幻灯片 才不会误判。
  [/ppt|\bslides?\b|slide[- _]?show|presentation|keynote|powerpoint|幻灯片/i, "做 PPT / 演示文稿（AI 直接把文档或主题生成可编辑的演示稿）", "文档办公"],
  [/excel|spreadsheet|xlsx|office|docx|\bword\b/i, "文档 / 表格处理，本地读写 Office 文件", "文档办公"],
  [/pdf/i, "PDF 解析、转换与批注处理", "文档办公"],
  [/\bnotes?\b|obsidian|markdown|wiki|notion|knowledge|second[- ]?brain/i, "笔记 / 知识库与 Markdown 写作管理", "知识管理"],
  [/agent|autogpt|crew|langgraph|autogen/i, "AI Agent 框架，把大模型串成能自己干活的流程", "AI / Agent"],
  [/llm|gpt|chatgpt|claude|qwen|deepseek|gemini|inference|vllm|ollama/i, "大模型推理 / 本地跑模型 / 模型服务", "AI / 大模型"],
  [/\brag\b|ragflow|embedding|vector|pinecone|milvus|chroma|faiss/i, "向量检索与 RAG 知识库，让模型查自己的资料", "RAG / 向量库"],
  [/diffusion|stable[- ]?diffusion|image[- ]?gen|comfyui|\bflux\b|sdxl|midjourney/i, "AI 文生图 / 图像生成与工作流", "AI 绘图"],
  // sing-box 是代理内核，必须排在音频规则之前：\bsing\b 会命中它（g 与 - 之间是词边界），
  // 早先它被标成「音频语音 + 网络代理 + 中转转发」三个标签。
  [/sing-?box/i, "通用代理内核 / 多协议翻墙客户端", "网络代理"],
  // (?!-?box)：sing-box 是代理内核，\bsing\b 在它上面照样命中（- 是词边界），
  // 光靠「把 sing-box 规则排前面」不够——规则是全部遍历收集的，这里不排除就会双命中。
  [/\btts\b|\bvoice\b|speech|whisper|\baudio\b|\basr\b|\bmusic\b|\bsing(ing|er)?\b(?!-?box)/i, "语音合成 / 语音识别 / 音频处理", "音频语音"],
  [/video|ffmpeg|subtitle|animation|remotion|剪辑|剪映/i, "视频处理、字幕与自动剪辑", "视频处理"],
  [/docker|kubernetes|k8s|helm|compose|container/i, "容器与容器编排，部署运维基础设施", "容器 / 运维"],
  // 裸 reverse 会先命中 "reverse engineering"（逆向规则在后面），把它判成代理工具。
  // 只对 "reverse proxy" 这种明确搭配生效。
  [/nginx|\bproxy\b|reverse[- _]?proxy|tunnel|frp|wireguard|vpn|clash|sing-?box|v2ray|xray/i, "网络代理 / 内网穿透 / 反向代理", "网络代理"],
  [/monitor|prometheus|grafana|observab|uptime[- _]?monitor|alertmanager/i, "监控告警、指标采集与日志观察", "监控运维"],
  // 裸 dashboard 覆盖面过大：几乎每个带 Web 界面的项目描述里都有它。
  // 只认「自托管 / NAS」语境里的搭配。
  [/\bnas\b|home[- ]?assistant|homelab|self[- ]?host|unraid|dashboard(?=.*(nas|homelab|self[- ]?host|server))/i, "自托管 / 家庭服务器 / NAS 面板类工具", "自托管"],
  [/scrap|crawl|spider|puppeteer|playwright|selenium|browser/i, "网页抓取与浏览器自动化", "爬虫自动化"],
  [/chrome|extension|userscript|tampermonkey|油猴/i, "浏览器扩展 / 油猴脚本，网页增强", "浏览器扩展"],
  [/macos|swiftui|\bios\b|iphone|uikit|app store/i, "Apple 平台（macOS / iOS）应用或工具", "Apple 生态"],
  [/\bmagisk\b|\bxposed\b|\bfrida\b|刷机|免root|root权限|android.*(逆向|破解|改机|去广告|脱壳|hook|magisk|xposed|frida|adb shell|root)|\badb\b.*(shell|push|pull|fastboot|设备|device)/i, "安卓系统改造、免 root / root 工具链", "安卓逆向"],
  [/decompil|disassembl|ghidra|\bida\b|kernel exploit|\bpwn\b|reversing|逆向/i, "逆向工程 / 二进制分析与漏洞研究", "逆向分析"],
  [/crypto|bitcoin|ethereum|blockchain|web3|钱包|wallet/i, "区块链 / 加密钱包相关", "区块链"],
  [/sql|database|postgres|mysql|sqlite|redis|mongo|\borm\b/i, "数据库与数据存储层的工具/客户端", "数据库"],
  [/terminal|\bshell\b|\bcli\b|\btui\b|command[- ]line/i, "命令行 / TUI 终端增强工具", "命令行工具"],
  [/editor|vim|neovim|emacs|\bide\b|code[- ]?editor/i, "代码编辑器 / 开发环境", "编辑器 IDE"],
  [/(?<![a-z0-9-])ui\b(?![-.])|component|tailwind|\breact\b|\bvue\b|svelte|frontend|\bcss\b|design system/i, "前端 UI 组件库 / 设计系统", "前端 UI"],
  [/\be2e\b|cypress|jest|vitest|test-framework|testing-framework/i, "测试框架与质量保障", "测试工程"],
  [/\bci\b|continuous (delivery|integration)|pipeline|github action|devops|ci\/cd/i, "CI/CD 与自动化部署流程", "CI/CD"],
  [/security|exploit|vulnerab|\bcve\b|pentest|malware|\bav\b|免杀|\bhack(ing|er)?\b|hackthebox|渗透|漏洞/i, "安全攻防 / 漏洞利用 / 恶意样本研究", "安全攻防"],
  // 裸 retro 会命中 retrofit（极流行的 Android HTTP 客户端），限定 retro 只在
  // 游戏语境里（retro game / retro-arch / 复古）才生效。
  [/\bgames?\b|emulator|retro[- _]?(game|arch|console|computing)|\bretro\b(?=.*(game|emulat|console|复古))|steam|游戏/i, "游戏相关工具 / 模拟器 / 游戏资源", "游戏"],
  [/download|magnet|torrent|\bbt\b|网盘|baidu|onedrive|aliyun/i, "下载 / 网盘 / 磁力资源管理", "下载网盘"],
  [/translate|i18n|字幕|translat/i, "翻译与多语言支持", "翻译"],
  // 不含 \bpdf\b：上面第 9 行的 pdf 规则已经给过「文档办公」，再命中一次会让
  // 纯 PDF 工具同时挂上「文档办公 + OCR」两个标签（实测 pdf-toolkit 就是如此）。
  [/\bocr\b|\bscan(n(ing|er))?\b|文字识别|识别文字/i, "OCR 文字识别与扫描件解析", "OCR"],
  [/proxy|中转|forward/i, "API 转发与请求中转", "中转转发"],
];

/** 数字缩写：1200 → 1.2k，18500 → 19k（与前端 app.js 的 fmt 语义一致） */
export function fmt(n) {
  // NaN 会一路穿透到最后 String(v) 变成 "NaN" 显示在卡片上。
  // stars 来自 GitHub 响应，字段缺失/被裁剪时是 undefined，非数字时统一按 0 处理。
  const num = Number(n);
  const v = Number.isFinite(num) ? num : 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k";
  return String(v);
}

/**
 * 生成中文简介 + 兜底标签。
 * @param {{description?:string, topics?:string[]|string, name?:string, language?:string,
 *          stars?:number, pushed_at?:string}} r
 * @returns {{digest:string, tags:string[]}}
 */
export function ruleDigest(r) {
  // topics 兼容数组与 JSON 字符串两种输入（服务端库里存的是 JSON 字符串，
  // 调用方直接传 GitHub API 响应时是数组）。
  const topics = Array.isArray(r.topics)
    ? r.topics
    : (() => { try { const a = JSON.parse(r.topics || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } })();
  const hay = [r.description, topics.join(" "), r.name, r.language].filter(Boolean).join(" ");
  const hits = [];
  for (const [re, sentence, tag] of RULES) if (re.test(hay)) hits.push({ sentence, tag });
  const tagSet = [...new Set(hits.map((h) => h.tag))].slice(0, 3);
  const sentences = hits.slice(0, 2).map((h) => h.sentence);
  const zh = (r.description || "").trim();
  const hasCJK = /[\u4e00-\u9fa5]/.test(zh);
  // pushed_at 可能是 number / Date（上游未归一化或测试直接传时间戳），
  // 直接 .slice 会抛 —— 统一先转成字符串再截。
  const pushed = (() => {
    const v = r.pushed_at;
    if (!v) return "";
    if (typeof v === "string") return v.slice(0, 10);
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
  })();
  let head;
  if (!sentences.length) head = zh;
  else if (hasCJK) head = `【${tagSet.join(" / ")}】${zh.slice(0, 130)}`;
  else head = sentences.join("；") + "。";
  if (!head) head = zh ? "用途：" + zh.slice(0, 120) + (zh.length > 120 ? "…" : "") : "暂无描述，点开右侧 README 看原文。";
  const tail = `${r.language || "未知语言"} · ⭐ ${fmt(r.stars)} · 最后推送 ${pushed}`;
  return { digest: `${head}\n${tail}`, tags: tagSet };
}
