---
name: news
description: Fetch and summarize the latest tech news across AI, frontend, and Web3 using opencli. Use when the user asks for latest news, trends, or updates in tech domains, or runs /news.
---

# /news — 最新科技资讯

通过 `opencli` 获取 AI、前端、Web3 等领域的最新动态。

## 用法

```
/news              # 所有领域
/news ai           # 仅 AI
/news frontend     # 仅前端
/news web3         # 仅 Web3
/news cn           # 仅中文资讯（36kr + V2EX）
/news ai frontend  # 多个领域组合
```

## 如何获取

对每个请求的领域**并行**运行以下命令。未指定领域时，默认获取全部。

### AI

```bash
opencli hackernews search "AI LLM agent" --limit 8
opencli producthunt posts --category ai-agents --limit 5
opencli devto tag ai --limit 5
```

### 前端

```bash
opencli devto tag javascript --limit 5
opencli devto tag frontend --limit 5
opencli v2ex node javascript --limit 5
```

### Web3

```bash
opencli hackernews search "blockchain web3 crypto ethereum" --limit 8
opencli 36kr search "web3" --limit 5
```

### 中文资讯（cn）

```bash
opencli 36kr news --limit 10
opencli v2ex hot --limit 10
```

## 整理规范

- 合并同领域的结果，去重后挑选 **3–5 条**最值得关注的。
- 优先近 7 天内容；若内容稀少，扩展至 30 天并注明。
- 每条必须包含**原文链接**（从命令输出中取 url/link 字段），附来源名称。
- 若命令输出无链接字段，用 `-f json` 重新执行一次以获取完整数据。
- HackerNews 的 Ask HN / 讨论帖无外链时，使用 `https://news.ycombinator.com/item?id=<id>` 作为链接（id 字段在 JSON 输出中可取到）。

## 输出格式

```
📰 *科技资讯速览*
_更新时间：<日期>_

*🤖 AI*
• [标题](原文链接) — HackerNews / ProductHunt / Dev.to
  一句话摘要。
• ...

*💻 前端*
• [标题](原文链接) — Dev.to / V2EX
  一句话摘要。
• ...

*🔗 Web3*
• [标题](原文链接) — HackerNews / 36氪
  一句话摘要。
• ...

*🇨🇳 中文*
• [标题](原文链接) — 36氪 / V2EX
  一句话摘要。
• ...
```

只输出用户请求的领域，省略其余部分。

## 注意

以上命令均使用公开 API，**无需浏览器**，可在容器内直接运行。
若 opencli 未安装，运行 `npm install -g @jackwener/opencli` 后重试。
