import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { TtlCache } from "./cache.ts";
import { loadConfig, updateConfig, type WebSearchConfig } from "./config.ts";
import {
	clearSecretMemory,
	deleteProfileSecret,
	describeBackend,
	getProfileSecret,
	isValidProfileName,
	readCredentials,
	saveProfileSecret,
	setDefaultProfile,
} from "./credentials.ts";
import {
	DeepSeekWebClient,
	fetchBalance,
	RateLimiter,
	validateApiKey,
	type FetchedPage,
	type SearchItem,
} from "./deepseek.ts";
import { formatFetch, formatSearch } from "./format.ts";
import { clampInt, isRecord, shortHash } from "./util.ts";

const AGENT_DIR = getAgentDir();
const SEARCH_MAX_CHARS = 24000;

const searchCache = new TtlCache<SearchItem[]>(200);
const fetchCache = new TtlCache<FetchedPage>(100);
const limiter = new RateLimiter(4.5);

const sessionStats = { searches: 0, fetches: 0, cacheHits: 0 };
let promptedThisProcess = false;

interface SearchParams {
	query: string;
	count?: number;
	need_content?: boolean;
	content_max_chars?: number;
	ori_question?: string;
	fresh?: boolean;
}

interface FetchParams {
	url: string;
	offset?: number;
	max_chars?: number;
	refresh?: boolean;
}

interface ResolvedKey {
	key: string;
	source: string;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(message, type);
}

async function resolveConfiguredKey(
	ctx: ExtensionContext,
	agentDir: string,
	config: WebSearchConfig,
): Promise<ResolvedKey | undefined> {
	const credentials = await readCredentials(agentDir);
	const profile = credentials.defaultProfile;
	if (profile) {
		const secret = await getProfileSecret(agentDir, profile, config);
		if (secret) return { key: secret, source: `profile:${profile}` };
	}

	try {
		const piKey = await ctx.modelRegistry.getApiKeyForProvider("deepseek");
		if (piKey) return { key: piKey, source: "pi-auth" };
	} catch {
		// Model registry may be unavailable in some modes; fall through to the environment.
	}

	const envKey = process.env.DEEPSEEK_API_KEY?.trim();
	if (envKey) return { key: envKey, source: "env" };
	return undefined;
}

async function reportBalance(ctx: ExtensionContext, config: WebSearchConfig, key: string): Promise<void> {
	try {
		const balance = await fetchBalance(key, { baseUrl: config.baseUrl, timeoutMs: 12000 });
		if (!balance.available) {
			notify(ctx, "DeepSeek account is unavailable (no balance or disabled).", "warning");
			return;
		}
		if (balance.entries.length === 0) return;
		const summary = balance.entries.map((entry) => `${entry.currency} ${entry.total}`).join(" / ");
		notify(ctx, `DeepSeek balance: ${summary}`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify(ctx, `Balance check failed: ${message}`, "warning");
	}
}

async function persistKey(
	ctx: ExtensionContext,
	agentDir: string,
	config: WebSearchConfig,
	profile: string,
	key: string,
	options: { showBalance?: boolean } = {},
): Promise<string | undefined> {
	if (!isValidProfileName(profile)) {
		notify(ctx, `Invalid profile name: ${profile} (letters, digits, _ and - only, max 32 characters).`, "error");
		return undefined;
	}

	const trimmed = key.trim();
	if (!trimmed) return undefined;

	const validation = await validateApiKey(trimmed, {
		baseUrl: config.baseUrl,
		timeoutMs: Math.min(config.timeoutMs, 12000),
	});
	if (validation.status === 401) {
		notify(ctx, "DeepSeek rejected that API key (401). Nothing was saved — check that you copied the whole key.", "error");
		return undefined;
	}
	if (!validation.ok && validation.status === 0) {
		notify(
			ctx,
			`Could not verify the key (network error: ${validation.message ?? "unknown"}). Saved anyway; it is re-checked on first use.`,
			"warning",
		);
	} else if (validation.status === 402) {
		notify(ctx, "The key is valid, but the account has no balance (402). Top up before using the tools.", "warning");
	}

	const saved = await saveProfileSecret(agentDir, profile, trimmed, config);
	if (saved.warning) notify(ctx, saved.warning, "warning");
	notify(
		ctx,
		`DeepSeek API key saved · profile=${profile} · storage=${describeBackend(saved.backend)} · ${saved.masked}`,
		"info",
	);

	if (options.showBalance) await reportBalance(ctx, config, trimmed);
	return trimmed;
}

async function promptForKey(
	ctx: ExtensionContext,
	agentDir: string,
	config: WebSearchConfig,
	profile = "default",
	options: { showBalance?: boolean } = {},
): Promise<string | undefined> {
	if (!ctx.hasUI) {
		throw new Error(
			"DeepSeek API key is not configured and this mode has no interactive UI. Set DEEPSEEK_API_KEY, or run /web-key sk-xxx in the TUI.",
		);
	}
	const keyUrl = "https://platform.deepseek.com/api_keys";
	let keyLink = keyUrl;
	let clickHint = "";
	try {
		if (getCapabilities().hyperlinks) {
			keyLink = hyperlink(keyUrl, keyUrl);
			clickHint = " (click to open)";
		}
	} catch {
		// Terminals without OSC 8 support show the plain URL.
	}
	const entered = await ctx.ui.input(
		`DeepSeek web search is installed. Paste your API key to enable ${config.searchToolName} / ${config.fetchToolName}.\nGet one at ${keyLink}${clickHint}`,
		"sk-...",
	);
	if (!entered || !entered.trim()) return undefined;
	return persistKey(ctx, agentDir, config, profile, entered, options);
}

async function ensureKey(ctx: ExtensionToolContext, agentDir: string, config: WebSearchConfig): Promise<string> {
	const resolved = await resolveConfiguredKey(ctx, agentDir, config);
	if (resolved) return resolved.key;

	if (!ctx.hasUI) {
		throw new Error(
			"DeepSeek API key is not configured. Set DEEPSEEK_API_KEY, or run /web-key sk-xxx in the TUI, then retry.",
		);
	}

	const key = await promptForKey(ctx, agentDir, config, "default", { showBalance: true });
	if (!key) {
		throw new Error("DeepSeek API key not set (input cancelled). Run /web-key sk-xxx or set DEEPSEEK_API_KEY, then retry.");
	}
	return key;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => (part as { text: string }).text)
		.join(" ");
}

function inferOriQuestion(ctx: ExtensionContext): string | undefined {
	try {
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index -= 1) {
			const entry = branch[index] as unknown;
			if (!isRecord(entry) || entry.type !== "message") continue;
			const message = entry.message;
			if (!isRecord(message) || message.role !== "user") continue;
			const text = contentText(message.content).replace(/\s+/g, " ").trim();
			if (text) return text.slice(0, 128);
		}
	} catch {
		// Session inspection is best effort.
	}
	return undefined;
}

function assertFetchableUrl(raw: string): URL {
	const value = raw.trim();
	if (!value) throw new Error("url must not be empty");
	if (value.length > 8192) throw new Error("url exceeds the 8192 character limit");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`invalid url: ${value}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http/https URLs are supported");
	if (!url.host) throw new Error("url must include a host");
	if (url.username || url.password) throw new Error("url must not contain a username or password");
	return url;
}

function createSearchParameters(fetchToolName: string) {
	return Type.Object({
	query: Type.String({
		description:
			'Search query, 1-128 characters. Supports operators: site:github.com, -site:example.com, -"exact phrase", "exact phrase", lang:zh,en, after:2025-01-01, before:2026, -excluded. Join multiple site: with " OR ".',
	}),
	count: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 50, description: "Number of results, 1-50 (default 8). Does not affect price per request." }),
	),
	need_content: Type.Optional(
		Type.Boolean({
			description: `Also return page text (default false; page text is heavy, prefer ${fetchToolName} once you have a URL).`,
		}),
	),
	content_max_chars: Type.Optional(
		Type.Integer({
			minimum: 200,
			maximum: 20000,
			description: "Max characters of page text per result when need_content is true (default 4000).",
		}),
	),
	ori_question: Type.Optional(
		Type.String({
			description: "The user question that triggered this search (1-128 chars) to clarify intent. Defaults to the last user message in the session.",
		}),
	),
	fresh: Type.Optional(Type.Boolean({ description: "Skip the session cache and search again." })),
});
}

const searchOutputSchema = Type.Object({
	query: Type.String(),
	count: Type.Integer(),
	truncated: Type.Boolean(),
	results: Type.Array(
		Type.Object({
			rank: Type.Integer(),
			title: Type.String(),
			url: Type.String(),
			snippet: Type.String(),
			summary: Type.String(),
			site_name: Type.Union([Type.String(), Type.Null()]),
			date: Type.Union([Type.String(), Type.Null()]),
			authority: Type.Union([Type.Number(), Type.Null()]),
			rerank_score: Type.Union([Type.Number(), Type.Null()]),
		}),
	),
});

const fetchParameters = Type.Object({
	url: Type.String({ description: "Page URL: http/https, with host, no username/password, at most 8192 characters." }),
	offset: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "Character offset to start from, for paging through long pages (served from the session cache).",
		}),
	),
	max_chars: Type.Optional(
		Type.Integer({ minimum: 500, maximum: 200000, description: "Max characters returned in this call (default 20000)." }),
	),
	refresh: Type.Optional(Type.Boolean({ description: "Ignore the cache and fetch the page again." })),
});

const fetchOutputSchema = Type.Object({
	url: Type.String(),
	title: Type.String(),
	offset: Type.Integer(),
	returned_chars: Type.Integer(),
	total_chars: Type.Integer(),
	next_offset: Type.Union([Type.Integer(), Type.Null()]),
});

export default async function deepSeekWebSearchExtension(pi: ExtensionAPI): Promise<void> {
	let config: WebSearchConfig | undefined = await loadConfig(AGENT_DIR);
	const getConfig = async (): Promise<WebSearchConfig> => {
		if (!config) config = await loadConfig(AGENT_DIR);
		return config;
	};

	const searchToolName = config.searchToolName;
	const fetchToolName = config.fetchToolName;
	const searchParameters = createSearchParameters(fetchToolName);
	const searchDescription = [
		"Search the live web with DeepSeek's own search index. Returns ranked results with title, URL, snippet, summary, site, publish date, authority and relevance.",
		'The query accepts search operators: site:, -site:, lang:, after:, before:, "exact phrase", -excluded.',
		"Keep need_content=false unless you need page text; once you have a URL, read it with " + fetchToolName + " instead.",
	].join("\n");
	const fetchDescription = [
		"Fetch a single web page through DeepSeek and return the cleaned Markdown body (title + text).",
		"Long pages are paged with offset / max_chars; the same URL is cached for the session, so paging does not re-fetch it.",
		"The target site may refuse the request (403) or expose no extractable text (404).",
	].join("\n");

	const ownedTools: OwnedToolMarker[] = [
		{ name: searchToolName, marker: searchDescription },
		{ name: fetchToolName, marker: fetchDescription },
	];

	pi.registerTool({
		name: searchToolName,
		label: searchToolName,
		description: searchDescription,
		promptSnippet: "Search the web (DeepSeek); supports site:/lang:/after:/before: operators",
		promptGuidelines: [
			`For anything current or uncertain (versions, releases, prices, news, docs updates), call ${searchToolName} instead of answering from memory.`,
			'Operators go directly into query: site:github.com, -site:example.com, lang:zh,en, after:2025-01-01, "exact phrase", -excluded.',
			"Add lang: when results should stay in a specific language.",
			`Judge by the summary/snippet first, then fetch only the URLs you need with ${fetchToolName}; do not repeat the same query.`,
		],
		parameters: searchParameters,
		outputSchema: searchOutputSchema,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const activeConfig = await getConfig();
			const key = await ensureKey(ctx, AGENT_DIR, activeConfig);

			const query = params.query.trim();
			if (!query) throw new Error("query must not be empty (1-128 characters)");
			if (query.length > 128) throw new Error(`query exceeds 128 characters (got ${query.length})`);

			const count = clampInt(params.count ?? activeConfig.defaultCount, 1, 50);
			const needContent = params.need_content === true;
			const contentMaxChars = clampInt(params.content_max_chars ?? activeConfig.contentMaxChars, 200, 20000);

			const cacheKey = `search:${shortHash(
				JSON.stringify({ base: activeConfig.baseUrl, query, count, needContent, contentMaxChars }),
				32,
			)}`;
			const cachedItems = params.fresh ? undefined : searchCache.get(cacheKey);
			let items = cachedItems;
			if (!items) {
				const client = new DeepSeekWebClient(key, {
					baseUrl: activeConfig.baseUrl,
					timeoutMs: activeConfig.timeoutMs,
					limiter,
				});
				items = await client.search(
					{
						query,
						count,
						needContent,
						oriQuestion: params.ori_question?.trim() || inferOriQuestion(ctx),
					},
					signal,
				);
				searchCache.set(cacheKey, items, activeConfig.cacheTtlSeconds * 1000);
				sessionStats.searches += 1;
			} else {
				sessionStats.cacheHits += 1;
			}

			const formatted = formatSearch(query, items, {
				maxChars: SEARCH_MAX_CHARS,
				contentMaxChars,
				fetchToolName,
			});
			return {
				content: [{ type: "text", text: formatted.content }],
				structuredContent: formatted.structured,
				details: formatted.details,
			};
		},
	});

	pi.registerTool({
		name: fetchToolName,
		label: fetchToolName,
		description: fetchDescription,
		promptSnippet: "Fetch a web page as Markdown (DeepSeek); supports offset/max_chars paging",
		promptGuidelines: [
			`Use ${fetchToolName} to open a specific URL, check the source, or read docs/README/blog posts instead of guessing their content.`,
			`${fetchToolName} returns one slice of the page: when it reports next_offset, continue with offset instead of fetching the same URL again.`,
			`${fetchToolName} only reaches public pages; intranet, login-only and credentialed URLs do not work.`,
		],
		parameters: fetchParameters,
		outputSchema: fetchOutputSchema,
		annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const activeConfig = await getConfig();
			const key = await ensureKey(ctx, AGENT_DIR, activeConfig);

			const url = assertFetchableUrl(params.url);
			const maxChars = clampInt(params.max_chars ?? activeConfig.fetchMaxChars, 500, 200000);
			const offset = Math.max(0, Math.trunc(params.offset ?? 0));

			const cacheKey = `fetch:${shortHash(`${activeConfig.baseUrl}\n${url.href}`, 32)}`;
			const cachedPage = params.refresh ? undefined : fetchCache.get(cacheKey);
			let page = cachedPage;
			if (!page) {
				const client = new DeepSeekWebClient(key, {
					baseUrl: activeConfig.baseUrl,
					timeoutMs: activeConfig.timeoutMs,
					limiter,
				});
				page = await client.fetchPage(url.href, signal);
				fetchCache.set(cacheKey, page, activeConfig.fetchCacheTtlSeconds * 1000);
				sessionStats.fetches += 1;
			} else {
				sessionStats.cacheHits += 1;
			}

			const formatted = formatFetch({
				url: url.href,
				title: page.title,
				content: page.content,
				offset,
				maxChars,
			});
			return {
				content: [{ type: "text", text: formatted.content }],
				structuredContent: formatted.structured,
				details: formatted.details,
			};
		},
	});

	pi.registerCommand("web-key", {
		description:
			"Manage the DeepSeek API key: /web-key sk-xxx | list | use <profile> | set <profile> [key] | delete <profile> | status",
		handler: async (args, ctx) => {
			const activeConfig = await getConfig();
			const raw = (args ?? "").trim();
			const tokens = raw.split(/\s+/).filter(Boolean);

			if (tokens.length === 0) {
				await interactiveKeyManager(ctx, AGENT_DIR, activeConfig);
				return;
			}

			const [first, ...rest] = tokens;
			switch (first) {
				case "list":
				case "status": {
					await showKeyStatus(ctx, AGENT_DIR, activeConfig);
					return;
				}
				case "use": {
					const profile = rest[0];
					if (!profile) {
						notify(ctx, "Usage: /web-key use <profile>", "warning");
						return;
					}
					const ok = await setDefaultProfile(AGENT_DIR, profile);
					notify(ctx, ok ? `Default profile switched to ${profile}` : `Unknown profile: ${profile}`, ok ? "info" : "error");
					return;
				}
				case "set": {
					const firstArg = rest[0];
					const profile = firstArg && !looksLikeApiKey(firstArg) ? firstArg : "default";
					const inlineKey = (firstArg && looksLikeApiKey(firstArg) ? rest : rest.slice(1)).join("");
					if (inlineKey) {
						await persistKey(ctx, AGENT_DIR, activeConfig, profile, inlineKey, { showBalance: true });
						return;
					}
					await promptForKey(ctx, AGENT_DIR, activeConfig, profile, { showBalance: true });
					return;
				}
				case "delete":
				case "remove":
				case "rm": {
					const credentials = await readCredentials(AGENT_DIR);
					const profile = rest[0] ?? credentials.defaultProfile;
					if (!profile) {
						notify(ctx, "No saved profiles to delete.", "error");
						return;
					}
					const removed = await deleteProfileSecret(AGENT_DIR, profile, activeConfig);
					notify(ctx, removed ? `Deleted profile: ${profile}` : `Unknown profile: ${profile}`, removed ? "info" : "error");
					return;
				}
				default: {
					if (looksLikeApiKey(first)) {
						await persistKey(ctx, AGENT_DIR, activeConfig, "default", first, { showBalance: true });
						return;
					}
					notify(
						ctx,
						"Usage: /web-key (interactive) | /web-key sk-xxx | /web-key list | /web-key use <profile> | /web-key set <profile> [key] | /web-key delete <profile> | /web-key status",
						"warning",
					);
				}
			}
		},
	});

	pi.registerCommand("web-status", {
		description: "Show the DeepSeek key source, profiles, balance, and session usage",
		handler: async (_args, ctx) => {
			const activeConfig = await getConfig();
			await showKeyStatus(ctx, AGENT_DIR, activeConfig);
			const resolved = await resolveConfiguredKey(ctx, AGENT_DIR, activeConfig);
			if (resolved) await reportBalance(ctx, activeConfig, resolved.key);
			const issues = collectOwnershipIssues(pi, ownedTools);
			if (issues.length > 0) notify(ctx, issues.join("; "), "warning");
			const searchStats = searchCache.stats();
			const fetchStats = fetchCache.stats();
			notify(
				ctx,
				`This session: ${sessionStats.searches} searches · ${sessionStats.fetches} fetches · ${sessionStats.cacheHits} cache hits\nCache: ${searchStats.size} search results / ${fetchStats.size} pages`,
				"info",
			);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		config = await loadConfig(AGENT_DIR);
		checkToolOwnership(ctx, pi, ownedTools);
		const resolved = await resolveConfiguredKey(ctx, AGENT_DIR, config);
		if (resolved) return;

		if (!config.promptOnStartup) return;
		if (event.reason !== "startup" && event.reason !== "new") return;

		// Only the interactive TUI auto-prompts. RPC / print clients must not block on startup;
		// they can still answer /web-key or pass DEEPSEEK_API_KEY.
		if (ctx.mode !== "tui") {
			notify(
				ctx,
				"pi-deepseek-websearch: no DeepSeek API key found. Run /web-key sk-xxx, or set DEEPSEEK_API_KEY.",
				"warning",
			);
			return;
		}
		if (promptedThisProcess) return;
		promptedThisProcess = true;

		const key = await promptForKey(ctx, AGENT_DIR, config, "default", { showBalance: true });
		if (key) return;

		// The user skipped the prompt: stop nagging on every start, keep /web-key available.
		await updateConfig(AGENT_DIR, { promptOnStartup: false }).catch(() => undefined);
		notify(
			ctx,
			"Skipped the DeepSeek API key prompt — web search stays disabled. Run /web-key sk-xxx anytime to enable it (this prompt will not appear again).",
			"info",
		);
	});

	pi.on("session_shutdown", async (event) => {
		const reason = (event as unknown as { reason?: string }).reason;
		if (reason === "new" || reason === "resume" || reason === "fork") return;
		searchCache.clear();
		fetchCache.clear();
		clearSecretMemory();
	});
}

interface OwnedToolMarker {
	name: string;
	marker: string;
}

const SELF_MODULE_URL: string | undefined = (() => {
	try {
		return typeof import.meta !== "undefined" ? (import.meta as { url?: string }).url : undefined;
	} catch {
		return undefined;
	}
})();

function normalizedPath(value: string): string {
	return value.replace(/\\/g, "/");
}

function selfModulePath(): string | undefined {
	if (!SELF_MODULE_URL?.startsWith("file:")) return undefined;
	try {
		return normalizedPath(fileURLToPath(SELF_MODULE_URL));
	} catch {
		return undefined;
	}
}

function isOwnedByThisExtension(tool: { description?: string; sourceInfo?: { path?: string } }, expected: OwnedToolMarker): boolean {
	if (tool.description === expected.marker) return true;
	const path = normalizedPath(String(tool.sourceInfo?.path ?? ""));
	if (!path) return false;
	const self = selfModulePath();
	if (self && path === self) return true;
	return path.includes("pi-deepseek-websearch");
}

/**
 * pi rejects two extensions that register the same tool name ("Tool \"x\" conflicts with <path>")
 * but silently lets a custom tool override a built-in one. Either way the model may end up without
 * this package's tool, so verify the registered entries still belong to us.
 */
function collectOwnershipIssues(pi: ExtensionAPI, tools: readonly OwnedToolMarker[]): string[] {
	let registered: ReturnType<ExtensionAPI["getAllTools"]>;
	try {
		registered = pi.getAllTools();
	} catch {
		return [];
	}

	const issues: string[] = [];
	for (const expected of tools) {
		const found = registered.find((candidate) => candidate.name === expected.name);
		if (!found) {
			issues.push(`tool ${expected.name} is not registered`);
			continue;
		}
		if (!isOwnedByThisExtension(found, expected)) {
			const source = found.sourceInfo?.path ?? "unknown source";
			issues.push(`tool name ${expected.name} is owned by ${source} (conflicting extension tools fail to load; built-in tools are overridden silently)`);
		}
	}
	return issues;
}

function checkToolOwnership(ctx: ExtensionContext, pi: ExtensionAPI, tools: readonly OwnedToolMarker[]): void {
	const issues = collectOwnershipIssues(pi, tools);
	if (issues.length === 0) return;
	if (process.env.PI_DEEPSEEK_WEBSEARCH_DEBUG === "1") console.error(`[pi-deepseek-websearch] ${issues.join("; ")}`);
	notify(
		ctx,
		`pi-deepseek-websearch: ${issues.join("; ")}. Rename searchToolName / fetchToolName in <agent-dir>/websearch/config.json, or uninstall the conflicting package, then run /reload.`,
		"error",
	);
}

function looksLikeApiKey(token: string): boolean {
	return /^sk-[A-Za-z0-9._-]{8,}$/.test(token);
}

async function showKeyStatus(
	ctx: ExtensionContext,
	agentDir: string,
	config: WebSearchConfig,
): Promise<void> {
	const credentials = await readCredentials(agentDir);
	const resolved = await resolveConfiguredKey(ctx, agentDir, config);
	const lines: string[] = [];
	lines.push(`Current key: ${resolved ? resolved.source : "not configured"}`);
	if (credentials.defaultProfile) lines.push(`Default profile: ${credentials.defaultProfile}`);
	lines.push(
		`Pi deepseek credential: ${(await hasPiAuth(ctx)) ? "configured" : "not configured"} · DEEPSEEK_API_KEY: ${process.env.DEEPSEEK_API_KEY ? "set" : "not set"}`,
	);
	lines.push(`Tools: ${config.searchToolName} / ${config.fetchToolName} (rename in config.json)`);

	const names = Object.keys(credentials.profiles).sort();
	if (names.length === 0) {
		lines.push("No profiles saved by this package (pi's deepseek credential is used when available)");
	} else {
		lines.push("Saved profiles:");
		for (const name of names) {
			const meta = credentials.profiles[name];
			const marker = name === credentials.defaultProfile ? "*" : " ";
			lines.push(
				` ${marker} ${name} · ${describeBackend(meta.backend)} · ••••${meta.last4} · ${meta.addedAt.slice(0, 10) || "-"}`,
			);
		}
	}
	lines.push("Usage: /web-key sk-xxx · /web-key set work · /web-key use work · /web-key delete work");
	notify(ctx, lines.join("\n"), "info");
}

async function hasPiAuth(ctx: ExtensionContext): Promise<boolean> {
	try {
		return Boolean(await ctx.modelRegistry.getApiKeyForProvider("deepseek"));
	} catch {
		return false;
	}
}

async function interactiveKeyManager(
	ctx: ExtensionCommandContext,
	agentDir: string,
	config: WebSearchConfig,
): Promise<void> {
	if (!ctx.hasUI) {
		notify(ctx, "This mode has no interactive UI. Use /web-key sk-xxx or set DEEPSEEK_API_KEY.", "error");
		return;
	}

	const resolved = await resolveConfiguredKey(ctx, agentDir, config);
	if (!resolved) {
		await promptForKey(ctx, agentDir, config, "default", { showBalance: true });
		return;
	}

	const credentials = await readCredentials(agentDir);
	const choices = [
		"Show status and balance",
		"Replace the default profile key",
		"Add a new profile",
		"Set the default profile",
		"Delete a profile",
		"Cancel",
	];
	const choice = await ctx.ui.select(`DeepSeek API key source: ${resolved.source}`, choices);
	if (!choice || choice === "Cancel") return;

	switch (choice) {
		case "Show status and balance": {
			await showKeyStatus(ctx, agentDir, config);
			await reportBalance(ctx, config, resolved.key);
			return;
		}
		case "Replace the default profile key": {
			await promptForKey(ctx, agentDir, config, "default", { showBalance: true });
			return;
		}
		case "Add a new profile": {
			const name = await ctx.ui.input("Profile name (letters, digits, _ or -, for example work)", "work");
			if (!name?.trim()) return;
			const profile = name.trim();
			if (!isValidProfileName(profile)) {
				notify(ctx, "Invalid profile name (letters, digits, _ and - only, max 32 characters).", "error");
				return;
			}
			await promptForKey(ctx, agentDir, config, profile, { showBalance: false });
			return;
		}
		case "Set the default profile": {
			const names = Object.keys(credentials.profiles).sort();
			if (names.length === 0) {
				notify(ctx, "No profiles saved by this package yet.", "warning");
				return;
			}
			const picked = await ctx.ui.select("Select the default profile", names);
			if (!picked) return;
			await setDefaultProfile(agentDir, picked);
			notify(ctx, `Default profile switched to ${picked}`, "info");
			return;
		}
		case "Delete a profile": {
			const names = Object.keys(credentials.profiles).sort();
			if (names.length === 0) {
				notify(ctx, "No profiles saved by this package yet.", "warning");
				return;
			}
			const picked = await ctx.ui.select("Select a profile to delete", names);
			if (!picked) return;
			const confirmed = await ctx.ui.confirm("Delete key", `Delete the stored key and record for profile "${picked}"?`);
			if (!confirmed) return;
			await deleteProfileSecret(agentDir, picked, config);
			notify(ctx, `Deleted profile: ${picked}`, "info");
			return;
		}
	}
}
