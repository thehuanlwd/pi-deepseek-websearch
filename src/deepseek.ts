import { asNumber, asString, isRecord, sleep } from "./util.ts";

export type ApiKind = "search" | "fetch";

export interface SearchItem {
	title?: string;
	url?: string;
	snippet?: string;
	summary?: string;
	content?: string;
	siteName?: string | null;
	date?: string | null;
	authority?: number | null;
	rerankScore?: number | null;
}

export interface SearchRequest {
	query: string;
	count: number;
	needContent: boolean;
	oriQuestion?: string;
	localization?: string;
}

export interface FetchedPage {
	title: string;
	content: string;
}

export class DeepSeekHttpError extends Error {
	readonly status: number;
	readonly apiMessage: string;
	readonly hint: string;
	readonly retryable: boolean;

	constructor(status: number, apiMessage: string, hint: string, retryable: boolean) {
		const summary = status > 0 ? `HTTP ${status}: ${apiMessage}` : apiMessage;
		super(hint ? `${summary} — ${hint}` : summary);
		this.name = "DeepSeekHttpError";
		this.status = status;
		this.apiMessage = apiMessage;
		this.hint = hint;
		this.retryable = retryable;
	}
}

/** The DeepSeek account limit is 5 QPS per endpoint; stay below it across all sessions in this process. */
export class RateLimiter {
	private nextAt = 0;
	private readonly intervalMs: number;
	private readonly now: () => number;
	private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;

	constructor(
		qps = 4.5,
		now: () => number = Date.now,
		sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
	) {
		this.intervalMs = 1000 / Math.max(0.5, qps);
		this.now = now;
		this.sleepImpl = sleepImpl;
	}

	async acquire(signal?: AbortSignal): Promise<void> {
		const now = this.now();
		const wait = Math.max(0, this.nextAt - now);
		this.nextAt = Math.max(now, this.nextAt) + this.intervalMs;
		if (wait > 0) await this.sleepImpl(wait, signal);
	}
}

export interface ClientOptions {
	baseUrl: string;
	timeoutMs?: number;
	limiter?: RateLimiter;
	fetchImpl?: typeof globalThis.fetch;
	sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
	maxRetries?: number;
}

function hintFor(status: number, kind: ApiKind): string {
	switch (status) {
		case 0:
			return "Network request failed or timed out. Check connectivity and retry.";
		case 400:
			return "Invalid request (query 1-128 characters, count 1-50, URL must be http/https with a host).";
		case 401:
			return "API key missing, invalid or revoked. Run /web-key to set a new one, or update DEEPSEEK_API_KEY.";
		case 402:
			return "DeepSeek account has no balance. Top up, then retry.";
		case 403:
			return kind === "fetch"
				? "The target site refused the fetch (safety policy). Look for another source with the search tool."
				: "Request blocked by safety policy.";
		case 404:
			return kind === "fetch"
				? "Could not retrieve this page: URL unavailable, blocked by the site, unsupported content type, or no extractable text."
				: "Endpoint not found (404). Check the configured Base URL.";
		case 408:
			return "Timed out while reading the request body; retried automatically. Try again later.";
		case 413:
			return "Request body exceeds the size limit.";
		case 429:
			return "Account-level rate limit hit (5 QPS for Search and for Fetch). Backed off and retried; reduce concurrency.";
		case 500:
		case 502:
		case 503:
		case 504:
			return "DeepSeek server error; retried automatically. Try again later.";
		default:
			return "";
	}
}

function parseApiError(text: string): { message: string } | undefined {
	if (!text) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined;
		const message = asString(parsed.error.message);
		return message ? { message } : undefined;
	} catch {
		return undefined;
	}
}

function normalizeItem(raw: unknown): SearchItem {
	if (!isRecord(raw)) return {};
	return {
		title: asString(raw.title) ?? "",
		url: asString(raw.url) ?? "",
		snippet: asString(raw.snippet) ?? "",
		summary: asString(raw.summary) ?? "",
		content: asString(raw.content) ?? "",
		siteName: raw.site_name === null ? null : (asString(raw.site_name) ?? null),
		date: raw.date === null ? null : (asString(raw.date) ?? null),
		authority: raw.authority === null ? null : (asNumber(raw.authority) ?? null),
		rerankScore: raw.rerank_score === null ? null : (asNumber(raw.rerank_score) ?? null),
	};
}

function parseRetryAfter(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value.trim());
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(15000, seconds * 1000);
	const date = Date.parse(value);
	if (Number.isFinite(date)) return Math.min(15000, Math.max(0, date - Date.now()));
	return undefined;
}

function requireObject(data: unknown, what: string): Record<string, unknown> {
	if (!isRecord(data)) throw new DeepSeekHttpError(200, `${what} response was not a JSON object`, "", false);
	return data;
}

export class DeepSeekWebClient {
	private readonly key: string;
	private readonly options: ClientOptions;

	constructor(key: string, options: ClientOptions) {
		this.key = key;
		this.options = options;
	}

	private get fetchImpl(): typeof globalThis.fetch {
		return this.options.fetchImpl ?? globalThis.fetch;
	}

	private get sleepImpl(): (ms: number, signal?: AbortSignal) => Promise<void> {
		return this.options.sleepImpl ?? sleep;
	}

	private async backoff(attempt: number, retryAfter: string | null, signal?: AbortSignal): Promise<void> {
		const fromHeader = parseRetryAfter(retryAfter);
		const delay = fromHeader ?? Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
		await this.sleepImpl(delay, signal);
	}

	private async request(
		path: string,
		body: unknown,
		kind: ApiKind,
		signal?: AbortSignal,
	): Promise<unknown> {
		const maxRetries = this.options.maxRetries ?? 2;
		const timeoutMs = this.options.timeoutMs ?? 60000;
		const url = `${this.options.baseUrl.replace(/\/+$/, "")}${path}`;

		for (let attempt = 0; ; attempt += 1) {
			if (this.options.limiter) await this.options.limiter.acquire(signal);

			const controller = new AbortController();
			const onAbort = () => controller.abort();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			if (signal) {
				if (signal.aborted) {
					clearTimeout(timer);
					throw new Error("Operation aborted");
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}

			let response: Response;
			let text: string;
			try {
				response = await this.fetchImpl(url, {
					method: "POST",
					headers: {
						authorization: `Bearer ${this.key}`,
						"content-type": "application/json",
						accept: "application/json",
					},
					body: JSON.stringify(body),
					signal: controller.signal,
				});
				text = await response.text();
			} catch (error) {
				clearTimeout(timer);
				if (signal) signal.removeEventListener("abort", onAbort);
				if (signal?.aborted) throw new Error("Operation aborted");
				const message = error instanceof Error ? error.message : String(error);
				if (attempt < maxRetries) {
					await this.backoff(attempt, null, signal);
					continue;
				}
				throw new DeepSeekHttpError(0, `request to ${path} failed: ${message}`, hintFor(0, kind), true);
			}
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);

			if (response.ok) {
				if (!text.trim()) return {};
				try {
					return JSON.parse(text) as unknown;
				} catch {
					throw new DeepSeekHttpError(
						response.status,
						`${path} returned a non-JSON response`,
						hintFor(response.status, kind),
						false,
					);
				}
			}

			const status = response.status;
			const apiMessage = parseApiError(text)?.message ?? (text.trim().slice(0, 300) || response.statusText);
			const retryable = status === 408 || status === 429 || status >= 500;
			if (retryable && attempt < maxRetries) {
				await this.backoff(attempt, response.headers.get("retry-after"), signal);
				continue;
			}
			throw new DeepSeekHttpError(status, apiMessage, hintFor(status, kind), retryable);
		}
	}

	async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchItem[]> {
		const body: Record<string, unknown> = {
			query: request.query,
			count: request.count,
			need_content: request.needContent,
		};
		if (request.oriQuestion) body.ori_question = request.oriQuestion;
		if (request.localization) body.localization = request.localization;

		const data = requireObject(await this.request("/v1/tools/search", body, "search", signal), "Search");
		if (!Array.isArray(data.results)) {
			throw new DeepSeekHttpError(200, "Search response is missing the results array", "", false);
		}
		return data.results.map(normalizeItem);
	}

	async fetchPage(url: string, signal?: AbortSignal): Promise<FetchedPage> {
		const data = requireObject(await this.request("/v1/tools/fetch", { url }, "fetch", signal), "Fetch");
		const title = asString(data.title) ?? "";
		const content = asString(data.content) ?? "";
		if (!content.trim()) {
			throw new DeepSeekHttpError(404, "Fetch returned no usable page text", hintFor(404, "fetch"), false);
		}
		return { title, content };
	}
}

export interface ValidationResult {
	ok: boolean;
	status: number;
	message?: string;
}

/** Free credential check via GET /models (does not consume Search/Fetch billing). */
export async function validateApiKey(
	key: string,
	options: { baseUrl: string; timeoutMs?: number; fetchImpl?: typeof globalThis.fetch },
): Promise<ValidationResult> {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12000);
	try {
		const response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, "")}/models`, {
			method: "GET",
			headers: { authorization: `Bearer ${key}`, accept: "application/json" },
			signal: controller.signal,
		});
		await response.text();
		if (response.ok) return { ok: true, status: response.status };
		if (response.status === 401) return { ok: false, status: 401, message: "invalid API key (401)" };
		if (response.status === 402) return { ok: false, status: 402, message: "no balance (402)" };
		return { ok: false, status: response.status, message: `verification failed (HTTP ${response.status})` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, status: 0, message };
	} finally {
		clearTimeout(timer);
	}
}

export interface BalanceEntry {
	currency: string;
	total: string;
	granted: string;
	toppedUp: string;
}

export interface BalanceInfo {
	available: boolean;
	entries: BalanceEntry[];
}

/** Balance lookup for /web-status. Free of charge. */
export async function fetchBalance(
	key: string,
	options: { baseUrl: string; timeoutMs?: number; fetchImpl?: typeof globalThis.fetch },
): Promise<BalanceInfo> {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12000);
	try {
		const response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, "")}/user/balance`, {
			method: "GET",
			headers: { authorization: `Bearer ${key}`, accept: "application/json" },
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			throw new DeepSeekHttpError(response.status, parseApiError(text)?.message ?? response.statusText, "", false);
		}
		const data = requireObject(JSON.parse(text) as unknown, "Balance");
		const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
		const entries: BalanceEntry[] = infos.filter(isRecord).map((info) => ({
			currency: asString(info.currency) ?? "?",
			total: asString(info.total_balance) ?? "0",
			granted: asString(info.granted_balance) ?? "0",
			toppedUp: asString(info.topped_up_balance) ?? "0",
		}));
		return { available: data.is_available === true, entries };
	} finally {
		clearTimeout(timer);
	}
}
