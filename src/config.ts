import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { asBoolean, asNumber, asString, isRecord, writeFileAtomic } from "./util.ts";

export const DEFAULT_BASE_URL = "https://api.deepseek.com";

export interface WebSearchConfig {
	/** Prompt for a missing API key on the first TUI start. Set to false after the user skips it. */
	promptOnStartup: boolean;
	/** Registered tool names. Rename them to avoid clashing with another web-search package. */
	searchToolName: string;
	fetchToolName: string;
	/** Default number of results for web_search. */
	defaultCount: number;
	/** Per-result character budget when need_content is true. */
	contentMaxChars: number;
	/** Default character budget returned by web_fetch (paged with offset). */
	fetchMaxChars: number;
	/** Search result cache TTL in seconds. */
	cacheTtlSeconds: number;
	/** Fetched page cache TTL in seconds. */
	fetchCacheTtlSeconds: number;
	/** Per-request timeout in milliseconds. */
	timeoutMs: number;
	/** API base URL. Override with PI_DEEPSEEK_WEBSEARCH_BASE_URL for tests or proxies. */
	baseUrl: string;
	/** Store the key in a 0600 plaintext file when no OS secret store is available. */
	allowPlaintextSecrets: boolean;
}

export const DEFAULT_CONFIG: WebSearchConfig = {
	promptOnStartup: true,
	searchToolName: "web_search_ds",
	fetchToolName: "web_fetch_ds",
	defaultCount: 8,
	contentMaxChars: 4000,
	fetchMaxChars: 20000,
	cacheTtlSeconds: 600,
	fetchCacheTtlSeconds: 3600,
	timeoutMs: 60000,
	baseUrl: DEFAULT_BASE_URL,
	allowPlaintextSecrets: false,
};

/** pi tool names end up in LLM function calling; keep them conservative. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function websearchDir(agentDir: string): string {
	return join(agentDir, "websearch");
}

export function configPath(agentDir: string): string {
	return join(websearchDir(agentDir), "config.json");
}

function normalizeBaseUrl(value: string): string {
	return value.replace(/\/+$/, "");
}

export async function loadConfig(agentDir: string): Promise<WebSearchConfig> {
	const config: WebSearchConfig = { ...DEFAULT_CONFIG };

	const envBaseUrl = process.env.PI_DEEPSEEK_WEBSEARCH_BASE_URL;
	if (envBaseUrl) config.baseUrl = normalizeBaseUrl(envBaseUrl);

	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(configPath(agentDir), "utf8"));
	} catch {
		return config;
	}
	if (!isRecord(raw)) return config;

	const promptOnStartup = asBoolean(raw.promptOnStartup);
	if (promptOnStartup !== undefined) config.promptOnStartup = promptOnStartup;
	const searchToolName = asString(raw.searchToolName);
	if (searchToolName && TOOL_NAME_PATTERN.test(searchToolName)) config.searchToolName = searchToolName;
	const fetchToolName = asString(raw.fetchToolName);
	if (fetchToolName && TOOL_NAME_PATTERN.test(fetchToolName)) config.fetchToolName = fetchToolName;
	const defaultCount = asNumber(raw.defaultCount);
	if (defaultCount !== undefined) config.defaultCount = Math.min(50, Math.max(1, Math.trunc(defaultCount)));
	const contentMaxChars = asNumber(raw.contentMaxChars);
	if (contentMaxChars !== undefined) config.contentMaxChars = Math.max(200, Math.trunc(contentMaxChars));
	const fetchMaxChars = asNumber(raw.fetchMaxChars);
	if (fetchMaxChars !== undefined) config.fetchMaxChars = Math.max(500, Math.trunc(fetchMaxChars));
	const cacheTtlSeconds = asNumber(raw.cacheTtlSeconds);
	if (cacheTtlSeconds !== undefined) config.cacheTtlSeconds = Math.max(0, Math.trunc(cacheTtlSeconds));
	const fetchCacheTtlSeconds = asNumber(raw.fetchCacheTtlSeconds);
	if (fetchCacheTtlSeconds !== undefined) config.fetchCacheTtlSeconds = Math.max(0, Math.trunc(fetchCacheTtlSeconds));
	const timeoutMs = asNumber(raw.timeoutMs);
	if (timeoutMs !== undefined) config.timeoutMs = Math.max(1000, Math.trunc(timeoutMs));
	const baseUrl = asString(raw.baseUrl);
	if (baseUrl && !envBaseUrl) config.baseUrl = normalizeBaseUrl(baseUrl);
	const allowPlaintextSecrets = asBoolean(raw.allowPlaintextSecrets);
	if (allowPlaintextSecrets !== undefined) config.allowPlaintextSecrets = allowPlaintextSecrets;

	return config;
}

export async function updateConfig(agentDir: string, patch: Partial<WebSearchConfig>): Promise<WebSearchConfig> {
	const current = await loadConfig(agentDir);
	const next: WebSearchConfig = { ...current, ...patch };
	const persisted: Record<string, unknown> = {};
	for (const key of Object.keys(DEFAULT_CONFIG) as (keyof WebSearchConfig)[]) {
		if (key === "baseUrl" && process.env.PI_DEEPSEEK_WEBSEARCH_BASE_URL) continue;
		persisted[key] = next[key];
	}
	await writeFileAtomic(configPath(agentDir), `${JSON.stringify(persisted, null, 2)}\n`);
	return next;
}
