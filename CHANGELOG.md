# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-17

First release.

### Added

- `web_search_ds` tool backed by `POST /v1/tools/search`: ranked results with title, URL,
  snippet, summary, site, date, authority and relevance. Supports `site:`, `-site:`, `lang:`,
  `after:`, `before:`, `"exact phrase"` and `-excluded` operators. `ori_question` defaults to
  the last user message.
- `web_fetch_ds` tool backed by `POST /v1/tools/fetch`: cleaned Markdown body with
  `offset` / `max_chars` paging served from the session cache.
- Session caches (10 min search, 1 h pages) so repeated calls are not billed twice.
- Process-wide rate limiting (4.5 QPS) below DeepSeek's account limit of 5 QPS, with
  exponential backoff and `Retry-After` support for 408 / 429 / 5xx.
- Key resolution order: saved profile → pi's `deepseek` credential → `DEEPSEEK_API_KEY`.
- Encrypted key storage: Windows DPAPI, macOS Keychain, Linux Secret Service. Secrets travel over
  stdin, never through argv; memory-only fallback when no OS store exists.
- First-run prompt (TUI only, once) with a clickable official key URL; skipping it disables
  further automatic prompts.
- `/web-key` (`sk-xxx`, `list`, `status`, `set`, `use`, `delete`, interactive manager) and
  `/web-status`, including free balance lookup via `GET /user/balance`.
- Tool-name collision awareness: `_ds` names coexist with other web-search packages, startup
  verifies the registered names still belong to this package, and the names are configurable in
  `config.json`.
- Context-lean results: no billing, cache or rate-limit text in tool output, flat Markdown
  layout, paging line only when more content exists.
- English UI and tool copy throughout; structured results (`structuredContent`) for codemode.

[0.1.0]: https://github.com/thehuan/pi-deepseek-websearch/releases/tag/v0.1.0
