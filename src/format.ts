import type { JsonValue } from "@earendil-works/pi-ai";
import type { SearchItem } from "./deepseek.ts";

export interface SearchStructuredResult {
	[key: string]: JsonValue;
	rank: number;
	title: string;
	url: string;
	snippet: string;
	summary: string;
	site_name: string | null;
	date: string | null;
	authority: number | null;
	rerank_score: number | null;
}

export interface SearchStructured {
	[key: string]: JsonValue;
	query: string;
	count: number;
	truncated: boolean;
	results: SearchStructuredResult[];
}

export interface SearchDetails {
	query: string;
	count: number;
	truncated: boolean;
	urls: string[];
}

export interface FormatSearchOptions {
	/** Total character budget for the model-facing text. */
	maxChars: number;
	/** Per-result budget for `content` when need_content was requested. */
	contentMaxChars: number;
	/** Name of the fetch tool, used in the "read the full page" hint. */
	fetchToolName: string;
}

function metaLine(item: SearchItem): string {
	const parts: string[] = [];
	if (item.siteName) parts.push(item.siteName);
	if (item.date && item.date.length >= 10) parts.push(item.date.slice(0, 10));
	if (typeof item.authority === "number") parts.push(`authority ${item.authority}`);
	if (typeof item.rerankScore === "number") parts.push(`score ${item.rerankScore.toFixed(1)}`);
	return parts.join(" · ");
}

/**
 * Render search results for the model. Only query-relevant material goes into the context:
 * no billing, cache or rate-limit chatter, since that information lives in the tool description.
 */
export function formatSearch(
	query: string,
	items: SearchItem[],
	options: FormatSearchOptions,
): { content: string; structured: SearchStructured; details: SearchDetails } {
	if (items.length === 0) {
		const content = [
			`Web search: ${query}`,
			"No results. Try shorter keywords, or drop site:/lang:/after:/before: filters.",
		].join("\n");
		return {
			content,
			structured: { query, count: 0, truncated: false, results: [] },
			details: { query, count: 0, truncated: false, urls: [] },
		};
	}

	const header = `Web search: ${query}`;
	const lines: string[] = [header];
	let used = header.length;
	let truncated = false;
	let shown = 0;

	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		const title = item.title?.trim() || item.url || "(untitled)";
		const meta = metaLine(item);
		const text = item.summary?.trim() || item.snippet?.trim() || "";

		const block: string[] = [`[${index + 1}] ${title}`];
		if (meta) block.push(meta);
		block.push(item.url || "(no url)");
		if (text) block.push(text);

		const page = item.content?.trim();
		if (page) {
			const clipped =
				page.length > options.contentMaxChars
					? `${page.slice(0, options.contentMaxChars)}\n… (+${page.length - options.contentMaxChars} chars; use ${options.fetchToolName} for the full page)`
					: page;
			// No indentation: four-space indents turn Markdown into code blocks and waste context.
			block.push("-- page text --", clipped);
		}

		const blockText = block.join("\n");
		if (used + blockText.length + 2 > options.maxChars) {
			truncated = true;
			lines.push(
				`… (${items.length - shown} of ${items.length} results omitted; narrow the query or lower count)`,
			);
			break;
		}
		lines.push(blockText);
		used += blockText.length + 2;
		shown += 1;
	}

	const structured: SearchStructured = {
		query,
		count: items.length,
		truncated,
		results: items.map((item, index) => ({
			rank: index + 1,
			title: item.title ?? "",
			url: item.url ?? "",
			snippet: item.snippet ?? "",
			summary: item.summary ?? "",
			site_name: item.siteName ?? null,
			date: item.date ?? null,
			authority: typeof item.authority === "number" ? item.authority : null,
			rerank_score: typeof item.rerankScore === "number" ? item.rerankScore : null,
		})),
	};

	const details: SearchDetails = {
		query,
		count: items.length,
		truncated,
		urls: items.map((item) => item.url ?? "").filter(Boolean),
	};

	return { content: lines.join("\n\n"), structured, details };
}

function adjustBoundary(text: string, index: number): number {
	if (index <= 0 || index >= text.length) return index;
	const code = text.charCodeAt(index);
	// Do not split a surrogate pair.
	if (code >= 0xdc00 && code <= 0xdfff) return index - 1;
	return index;
}

export interface SliceResult {
	text: string;
	offset: number;
	end: number;
	total: number;
	nextOffset: number | null;
}

export function sliceContent(content: string, offset: number, maxChars: number): SliceResult {
	const total = content.length;
	const start = adjustBoundary(content, Math.min(Math.max(0, offset), total));
	let end = Math.min(total, start + Math.max(1, maxChars));
	// Do not split a surrogate pair.
	if (end < total) end = adjustBoundary(content, end);
	// Guarantee forward progress even when the budget lands inside a surrogate pair.
	if (end <= start && start < total) end = Math.min(total, start + 2);
	return {
		text: content.slice(start, end),
		offset: start,
		end,
		total,
		nextOffset: end < total ? end : null,
	};
}

export interface FetchStructured {
	[key: string]: JsonValue;
	url: string;
	title: string;
	offset: number;
	returned_chars: number;
	total_chars: number;
	next_offset: number | null;
}

export interface FetchDetails {
	url: string;
	title: string;
	offset: number;
	returnedChars: number;
	totalChars: number;
	nextOffset: number | null;
}

export function formatFetch(input: {
	url: string;
	title: string;
	content: string;
	offset: number;
	maxChars: number;
}): { content: string; structured: FetchStructured; details: FetchDetails } {
	const slice = sliceContent(input.content, input.offset, input.maxChars);
	const title = input.title.trim() || input.url;
	const parts = [title, input.url];

	// The paging line only matters when there is more to read.
	if (slice.nextOffset !== null) parts.push(`chars ${slice.offset}-${slice.end} of ${slice.total}`);
	else if (slice.text.length === 0 && slice.total > 0) parts.push(`(offset ${slice.offset} is past the end; total ${slice.total} chars)`);

	parts.push("---", slice.text);
	if (slice.nextOffset !== null) parts.push("---", `… continue with offset=${slice.nextOffset}`);

	const structured: FetchStructured = {
		url: input.url,
		title: input.title,
		offset: slice.offset,
		returned_chars: slice.text.length,
		total_chars: slice.total,
		next_offset: slice.nextOffset,
	};

	const details: FetchDetails = {
		url: input.url,
		title: input.title,
		offset: slice.offset,
		returnedChars: slice.text.length,
		totalChars: slice.total,
		nextOffset: slice.nextOffset,
	};

	return { content: parts.join("\n"), structured, details };
}
