# pi-deepseek-websearch

给 [pi](https://pi.dev) 加上原生的联网搜索与网页阅读能力，基于 DeepSeek 官方 Search / Fetch 接口。

两个模型可调用的工具，**不引入任何第三方兜底**：

| 工具 | 作用 |
|---|---|
| `web_search_ds` | 联网搜索：标题、URL、短摘要、长摘要、站点、发布时间、权威度、相关度 |
| `web_fetch_ds` | 抓取单个网页为 Markdown 正文，支持 `offset` / `max_chars` 分页 |

特点：

- **已经在 pi 里配置过 DeepSeek 就零配置**：`/login deepseek` 或 `DEEPSEEK_API_KEY` 直接被复用
- **首次使用只问一次**（仅 TUI）：输入后先校验，再用系统密钥库加密保存；不写入 `auth.json`，不存明文
- **上下文克制**：结果只含与查询相关的内容；计费/缓存/限速说明只放在工具描述里，不重复进上下文
- **正常工作时完全无感**：没有状态栏、没有启动横幅
- **干净**：请求只发往 `api.deepseek.com`，没有搜索兜底、没有阅读代理
- 进程内限速 4.5 QPS（低于官方账号级 5 QPS），408/429/5xx 自动退避重试，会话级缓存避免重复计费

English: [README.md](README.md)

## 安装

```bash
pi install npm:@thehuan/pi-deepseek-websearch
```

本地开发：

```bash
pi install ./pi-deepseek-websearch   # 写入 settings
pi -e ./pi-deepseek-websearch        # 仅本次运行加载
```

需要 pi 1.3.0 或更新版本（已在 1.3.0 上验证）。

## 首次使用

启动 `pi` 后，按以下顺序解析 Key：

1. 本包保存的 profile（`/web-key`）
2. pi 官方的 `deepseek` 凭据（`/login deepseek` 或 `DEEPSEEK_API_KEY`）
3. 都没有 → TUI 里弹一次输入框：

   ```
   DeepSeek web search is installed. Paste your API key to enable web_search_ds / web_fetch_ds.
   Get one at https://platform.deepseek.com/api_keys (click to open)
   ```

   回车保存（用免费的 `GET /models` 校验）。Esc 跳过，之后不会再自动弹。

`--print` / RPC / CI 等非交互模式不会弹框：设置 `DEEPSEEK_API_KEY` 或用 `/web-key sk-xxx`。

## 工具

### `web_search_ds`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | 必填 | 1-128 字符，支持 `site:`、`-site:`、`lang:`、`after:`、`before:`、`"精确短语"`、`-排除词` |
| `count` | integer | `8` | 1-50，不影响单次价格 |
| `need_content` | boolean | `false` | 同时返回正文；已有 URL 时用 `web_fetch_ds` 更省 |
| `content_max_chars` | integer | `4000` | `need_content` 时每条正文上限 |
| `ori_question` | string | 最后一条用户消息 | 触发搜索的原始问题，提升意图匹配 |
| `fresh` | boolean | `false` | 跳过会话缓存 |

操作符直接写进 `query`：

```
DeepSeek V4 发布 site:github.com OR site:huggingface.co lang:zh after:2025-01-01
俄乌 战况 -site:example.com -"release notes" before:2026-06-01
```

输出形态：

```
Web search: <query>

[1] <标题>
<站点> · <日期> · authority 3 · score 2.4
<URL>
<长摘要或短摘要>
-- page text --            （仅 need_content 时）
<正文>
```

每条结果是扁平结构（**没有 4 空格缩进**），不会破坏 Markdown，也不会把计费/缓存行塞进上下文。

### `web_fetch_ds`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | 必填 | http/https，含 host，无用户名密码，≤8192 字符 |
| `offset` | integer | `0` | 分页起点（命中会话缓存，不重复计费） |
| `max_chars` | integer | `20000` | 本次返回上限 |
| `refresh` | boolean | `false` | 忽略缓存重新抓取 |

只有确实还有后续内容时才输出分页信息：

```
页面标题
https://example.com/page
chars 0-20000 of 54321
---
<markdown>
---
… continue with offset=20000
```

工具结果分三部分：`content`（给模型读的紧凑 Markdown）、`structuredContent`（给 codemode 脚本）、`details`（给 UI 渲染的轻量数据）。

## 命令

| 命令 | 说明 |
|---|---|
| `/web-key` | 交互式管理：查看状态/余额、更换默认 Key、添加/选择/删除 profile |
| `/web-key sk-xxx` | 保存到 `default` profile（Key 会进入会话记录；共享会话请用交互式或环境变量） |
| `/web-key list` / `status` | 查看 Key 来源、profile、工具名、pi/环境变量状态 |
| `/web-key set work [sk-xxx]` | 保存到指定 profile；省略 Key 则弹框输入 |
| `/web-key use work` | 切换默认 profile |
| `/web-key delete work` | 删除 profile 及其密文 |
| `/web-status` | Key 来源、余额、本次会话调用与缓存统计 |

多 profile 适合区分个人 Key / 团队 Key / 不同计费账号。

## Key 存储

```
<agent-dir>/websearch/
├── credentials.json      # 只有元数据：backend、last4、时间
├── secrets/<hash>.dpapi  # 加密后的密钥（每个 profile 一个文件）
└── config.json
```

- **Windows**：DPAPI（`CurrentUser`）。密钥以 base64 通过 stdin 传给 PowerShell，不出现在进程列表里；密文绑定当前 Windows 用户与本机
- **macOS**：Keychain（`security`）
- **Linux**：Secret Service（`secret-tool`）
- **兜底**：没有系统密钥库时只在内存中保留（本次会话有效）并给出警告；只有 `allowPlaintextSecrets: true` 才会写 0600 明文文件
- 解密后的 Key 只存在于内存，退出即清空；错误信息不含 Key

`<agent-dir>` 默认 `~/.pi/agent`，遵循 `PI_CODING_AGENT_DIR`。

## 配置

`<agent-dir>/websearch/config.json`（按需创建）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `searchToolName` | `web_search_ds` | 搜索工具名（可改名避开冲突） |
| `fetchToolName` | `web_fetch_ds` | 抓取工具名 |
| `promptOnStartup` | `true` | 首次 TUI 启动是否询问 Key；跳过输入后自动置 `false` |
| `defaultCount` | `8` | `web_search_ds` 默认条数 |
| `contentMaxChars` | `4000` | 每条正文默认上限 |
| `fetchMaxChars` | `20000` | `web_fetch_ds` 默认上限 |
| `cacheTtlSeconds` | `600` | 搜索结果缓存 |
| `fetchCacheTtlSeconds` | `3600` | 网页缓存 |
| `timeoutMs` | `60000` | 单请求超时 |
| `allowPlaintextSecrets` | `false` | 是否允许 0600 明文兜底 |
| `baseUrl` | `https://api.deepseek.com` | 可用 `PI_DEEPSEEK_WEBSEARCH_BASE_URL` 覆盖 |

## 计费与限速

- Search / Fetch 均按**成功请求**计费：**¥5 / 1000 次**（约 ¥0.005 一次），`count` 不影响单价
- 空结果、失败、超时**不计费**
- 账号级 **5 QPS**（Search 与 Fetch 各自独立）；本扩展在进程内限到 4.5 QPS，并对 408/429/5xx 自动退避
- 会话缓存（搜索 10 分钟、网页 1 小时）避免重复计费
- `/web-status` 可查余额（`GET /user/balance`，免费）

## 工具名与冲突

pi 处理工具名的实际行为（已在 1.3.0 验证）：

- **两个扩展注册同名工具 = 加载冲突**：pi 报 `Tool "x" conflicts with <path>`，扩展加载失败
- **自定义工具复用内置工具名**（`read`、`bash` 等）：会静默覆盖内置工具

所以本包用 `web_search_ds` / `web_fetch_ds`，而常见包用 `web_search` / `web_fetch`：这样可以和
`pi-web-access`、`@parallel-web/pi-extension`、`@ollama/pi-web-search` 等共存，而不是启动失败。
两套工具会同时出现在模型工具列表里，由 description 区分。

启动时还会校验这些名字是否仍属于本包，被他人占用会给出警告。名字可配置——改名即可：

```json
{ "searchToolName": "web_search", "fetchToolName": "web_fetch" }
```

然后 `/reload`。

## 隐私

搜索词和 URL 会发送给 DeepSeek，除此之外不向任何第三方发送数据（没有搜索兜底、没有阅读代理）。不适用的任务请关闭这两个工具。

## 故障排查

| 现象 | 处理 |
|---|---|
| 401 | Key 缺失/无效/被撤销 → `/web-key sk-xxx` |
| 402 | 余额不足，充值后重试 |
| 403（fetch） | 目标站点拒绝抓取 → 用 `web_search_ds` 找其他来源 |
| 404（fetch） | URL 不可用、被拦截或无可提取正文 |
| 429 | 触发限速；已自动退避，减少并发调用 |
| 工具消失 | `/web-key status` 查看工具名与来源；启动时也会报告名称冲突 |
| 反复弹 Key 输入 | 把 `promptOnStartup` 设为 `false`，或用 `DEEPSEEK_API_KEY` |

## 开发

```bash
npm install                 # 安装 peer（pi 宿主包）与开发依赖
npm test                    # 23 个单测，不联网、不需要 Key
npm run typecheck           # tsc --noEmit
```

单测覆盖：格式化与分页（含代理对边界）、缓存 TTL/LRU、HTTP 重试语义（401/429/5xx）、DPAPI 往返、profile 元数据。

三个零成本探针会跑真实 pi 运行时和对本地 mock 的完整工具链：

```bash
# 一次性：把 pi 的宿主包链接到 ./node_modules（Windows 用 mklink /J）
node scripts/probe.ts ./pi-deepseek-websearch    # pi 是否加载、注册了哪些命令、状态输出
node scripts/keyflow.ts ./pi-deepseek-websearch  # /web-key → 校验 → DPAPI → 元数据
node scripts/toolflow.ts                         # 执行两个工具、缓存/分页、改名、冲突告警
```

`scripts/` 与 `test/` 不会进入发布包。

### 发布

```bash
npm version patch|minor        # 升版本并打 tag
npm publish                    # scope 包默认公开（publishConfig.access=public）
pi install npm:@thehuan/pi-deepseek-websearch
```

`pi-package` 关键字是 pi 包市场发现本包的依据。

## 许可证

MIT
