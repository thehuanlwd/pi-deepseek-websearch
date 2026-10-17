# pi-deepseek-websearch

Native web search and page reading for [pi](https://pi.dev), backed by the official DeepSeek Search / Fetch API.

Two model-callable tools, no third-party fallback:

| Tool | What it does |
|---|---|
| `web_search_ds` | Live web search → ranked results with title, URL, snippet, summary, site, publish date, authority and relevance |
| `web_fetch_ds` | Fetch one page → cleaned Markdown body, paged with `offset` / `max_chars` |

Highlights:

- **Zero config if you already use DeepSeek in pi** — `/login deepseek` or `DEEPSEEK_API_KEY` is reused automatically.
- **First run asks once** (TUI only). The key is validated, then encrypted with the OS key store — never written to `auth.json` and never stored in plain text.
- **Context-lean output** — results carry only query-relevant fields. Billing, cache and rate-limit notes live in the tool description, not in every result.
- **Silent when working** — no status bar entry, no startup banner.
- **No surprises** — no fallback to Jina/Serp/other providers; requests only go to `api.deepseek.com`.
- Bounded concurrency (4.5 QPS, below DeepSeek's 5 QPS account limit), retry with backoff on 408/429/5xx, and a session cache so repeated requests are not paid twice.

中文说明：[README.zh-CN.md](README.zh-CN.md)

## Install

```bash
pi install npm:@thehuan/pi-deepseek-websearch
```

From a local checkout (development):

```bash
pi install ./pi-deepseek-websearch   # add to settings
pi -e ./pi-deepseek-websearch        # load for one run only
```

Requires pi 1.3.0 or newer (verified against 1.3.0).

## First run

Start `pi`. The extension resolves a key in this order:

1. A profile saved by this package (`/web-key`).
2. pi's own `deepseek` credential (`/login deepseek`, or `DEEPSEEK_API_KEY`).
3. Nothing → in TUI it asks once:

   ```
   DeepSeek web search is installed. Paste your API key to enable web_search_ds / web_fetch_ds.
   Get one at https://platform.deepseek.com/api_keys (click to open)
   ```

   Enter saves (validated against `GET /models`, which is free). Esc skips; the prompt never appears again automatically.

Non-interactive modes (`--print`, RPC, CI) never block on a dialog: set `DEEPSEEK_API_KEY` or run `/web-key sk-xxx`.

## Tools

### `web_search_ds`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `query` | string | required | 1-128 chars. Supports `site:`, `-site:`, `lang:`, `after:`, `before:`, `"exact phrase"`, `-excluded` |
| `count` | integer | `8` | 1-50; does not change the price per request |
| `need_content` | boolean | `false` | Also return page text; prefer `web_fetch_ds` once you have a URL |
| `content_max_chars` | integer | `4000` | Per-result page-text budget |
| `ori_question` | string | last user message | User question that triggered the search, improves intent matching |
| `fresh` | boolean | `false` | Skip the session cache |

Operators go directly into `query`, for example:

```
DeepSeek V4 发布 site:github.com OR site:huggingface.co lang:zh after:2025-01-01
俄乌 战况 -site:example.com -"release notes" before:2026-06-01
```

Output shape:

```
Web search: <query>

[1] <title>
<site> · <date> · authority 3 · score 2.4
<url>
<summary or snippet>
-- page text --            (only with need_content)
<content>
```

Each result block is flat (no 4-space indentation), so Markdown pages stay intact and no invoice/cache lines enter the context.

### `web_fetch_ds`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `url` | string | required | http/https, host required, no credentials, ≤8192 chars |
| `offset` | integer | `0` | Character offset for paging; served from the session cache |
| `max_chars` | integer | `20000` | Slice size for this call |
| `refresh` | boolean | `false` | Ignore the cache and fetch again |

Paging information is printed only when there is more to read:

```
Page title
https://example.com/page
chars 0-20000 of 54321
---
<markdown>
---
… continue with offset=20000
```

Tool results have three parts: `content` (compact Markdown for the model), `structuredContent` (JSON for codemode scripts), `details` (lightweight data for the transcript).

## Commands

| Command | Description |
|---|---|
| `/web-key` | Interactive manager: show status/balance, replace the default key, add/select/delete profiles |
| `/web-key sk-xxx` | Save to the `default` profile (the key appears in the session log — prefer `/web-key` or env vars in shared sessions) |
| `/web-key list` / `status` | Show key source, profiles, tools, and pi/env configuration |
| `/web-key set work [sk-xxx]` | Save to a named profile; prompts when the key is omitted |
| `/web-key use work` | Switch the default profile |
| `/web-key delete work` | Delete a profile and its secret |
| `/web-status` | Key source, balance, session call/cache counters |

Multiple profiles are useful for personal vs. team keys or separate billing accounts.

## Key storage

```
<agent-dir>/websearch/
├── credentials.json      # metadata only: backend, last4, timestamps
├── secrets/<hash>.dpapi  # encrypted secret (one file per profile)
└── config.json
```

- **Windows**: DPAPI (`CurrentUser`). The secret travels to PowerShell over stdin as base64, so it never appears in the process list. Ciphertext is bound to the Windows user and machine.
- **macOS**: Keychain via `security`.
- **Linux**: Secret Service via `secret-tool`.
- **Fallback**: if no OS store is available, the key is kept in memory for the session and you get a warning. Only `allowPlaintextSecrets: true` writes a `0600` plaintext file.
- Decrypted keys live in memory only and are dropped on exit. Error messages never include the key.

`<agent-dir>` defaults to `~/.pi/agent` and follows `PI_CODING_AGENT_DIR`.

## Configuration

`<agent-dir>/websearch/config.json` (created on demand):

| Key | Default | Description |
|---|---|---|
| `searchToolName` | `web_search_ds` | Registered tool name (rename to avoid collisions) |
| `fetchToolName` | `web_fetch_ds` | Registered tool name |
| `promptOnStartup` | `true` | Ask for a key on the first TUI start; set to `false` after a skip |
| `defaultCount` | `8` | Default `count` for `web_search_ds` |
| `contentMaxChars` | `4000` | Default page-text budget per result |
| `fetchMaxChars` | `20000` | Default `max_chars` for `web_fetch_ds` |
| `cacheTtlSeconds` | `600` | Search result cache |
| `fetchCacheTtlSeconds` | `3600` | Page cache |
| `timeoutMs` | `60000` | Per-request timeout |
| `allowPlaintextSecrets` | `false` | Permit a `0600` plaintext fallback |
| `baseUrl` | `https://api.deepseek.com` | Override with `PI_DEEPSEEK_WEBSEARCH_BASE_URL` |

## Billing and limits

- **¥5 per 1,000 successful requests** (~¥0.005 each) for both Search and Fetch; `count` does not change the price.
- Empty results, failures and timeouts are not billed.
- **5 QPS per account** for Search and for Fetch independently. This extension self-limits to 4.5 QPS across the process and backs off on 408/429/5xx.
- Session caches (10 min for search, 1 h for pages) prevent paying twice for repeated identical calls.
- `/web-status` shows the account balance (`GET /user/balance`, free).

## Tool names and collisions

pi resolves tool names as follows (verified against pi 1.3.0):

- **Two extensions with the same tool name is a load conflict**: pi reports
  `Tool "x" conflicts with <path>` and the extension fails to load.
- **A custom tool that reuses a built-in name** (`read`, `bash`, …) silently overrides the built-in.

This package therefore registers `web_search_ds` / `web_fetch_ds` while other packages use
`web_search` / `web_fetch`: it can coexist with `pi-web-access`, `@parallel-web/pi-extension`,
`@ollama/pi-web-search` and similar packages instead of aborting the load. Both tools then appear
in the model's tool list and are distinguished by their descriptions.

Startup also verifies that the registered names still belong to this package and warns otherwise.
Names are configurable — rename them in `config.json`:

```json
{ "searchToolName": "web_search", "fetchToolName": "web_fetch" }
```

then `/reload`.

## Privacy

Search queries and URLs are sent to DeepSeek. Nothing goes anywhere else — there is no search fallback and no reader proxy. Disable the tools if that is not acceptable for the current task.

## Troubleshooting

| Symptom | Fix |
|---|---|
| 401 | Key missing/invalid/revoked → `/web-key sk-xxx` |
| 402 | No balance → top up |
| 403 on fetch | Site refused the fetch → find another source with `web_search_ds` |
| 404 on fetch | URL unavailable, blocked, or no extractable text |
| 429 | Rate limited; the extension already backed off — reduce concurrency |
| Tools missing | `/web-key status` shows names and source; startup also reports name collisions |
| Key prompt keeps appearing | Set `promptOnStartup: false`, or keep a key in `DEEPSEEK_API_KEY` |

## Development

```bash
npm install                 # peer deps (pi host packages) + dev deps
npm test                    # 23 unit tests, no network, no key
npm run typecheck           # tsc --noEmit
```

The unit tests cover formatting/paging (including surrogate pairs), cache TTL/LRU, HTTP retry semantics (401/429/5xx), DPAPI round-trip, and profile metadata.

Three zero-cost probes exercise the real pi runtime and the tool path against a local mock of the API:

```bash
# one-time: link pi's host packages into ./node_modules (Windows: mklink /J)
node scripts/probe.ts ./pi-deepseek-websearch    # does pi load it? which commands? status output
node scripts/keyflow.ts ./pi-deepseek-websearch  # /web-key -> validate -> DPAPI -> metadata
node scripts/toolflow.ts                         # execute both tools, cache/paging, rename, collision warning
```

`scripts/` and `test/` are not part of the published tarball.

### Release

```bash
npm version patch|minor        # bump + tag
npm publish                    # scoped public package (publishConfig.access=public)
pi install npm:@thehuan/pi-deepseek-websearch
```

The `pi-package` keyword is what makes the package discoverable in the pi package gallery.

## License

MIT
