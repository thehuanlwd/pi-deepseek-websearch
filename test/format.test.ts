import assert from "node:assert/strict";
import { test } from "node:test";
import { formatFetch, formatSearch, sliceContent } from "../src/format.ts";
import type { SearchItem } from "../src/deepseek.ts";

const items: SearchItem[] = [
	{
		title: "DeepSeek V4 released",
		url: "https://example.com/a",
		snippet: "short",
		summary: "A much longer summary about the release and its capabilities.",
		siteName: "Example",
		date: "2026-06-01T00:00:00+00:00",
		authority: 3,
		rerankScore: 2.4,
		content: "",
	},
	{
		title: "Second result",
		url: "https://example.com/b",
		snippet: "snippet two",
		summary: "",
		siteName: null,
		date: null,
		authority: null,
		rerankScore: null,
		content: "",
	},
];

const options = { maxChars: 10000, contentMaxChars: 1000, fetchToolName: "web_fetch_ds" };

test("formatSearch renders compact ranked results", () => {
	const result = formatSearch("deepseek", items, options);
	assert.match(result.content, /^Web search: deepseek/);
	assert.match(result.content, /\[1\] DeepSeek V4 released/);
	assert.match(result.content, /https:\/\/example\.com\/a/);
	assert.match(result.content, /Example · 2026-06-01 · authority 3 · score 2\.4/);
	assert.equal(result.structured.results.length, 2);
	assert.equal(result.structured.results[0].site_name, "Example");
	assert.equal(result.structured.results[1].authority, null);
	assert.deepEqual(result.details.urls, ["https://example.com/a", "https://example.com/b"]);
});

test("formatSearch keeps billing, cache and rate-limit chatter out of the context", () => {
	const result = formatSearch("deepseek", items, options);
	for (const noise of ["¥", "price", "priced", "bill", "cost", "cached", "cache hit", "QPS", "rate limit", "0.005"]) {
		assert.ok(!result.content.toLowerCase().includes(noise.toLowerCase()), `unexpected context noise: ${noise}`);
	}
	assert.ok(!("cached" in result.structured));
});

test("formatSearch handles empty results with a short hint", () => {
	const result = formatSearch("nothing", [], options);
	assert.match(result.content, /No results\./);
	assert.ok(result.content.split("\n").length <= 2);
	assert.equal(result.structured.results.length, 0);
});

test("formatSearch truncates when the budget is exhausted", () => {
	const result = formatSearch("deepseek", items, { ...options, maxChars: 120 });
	assert.equal(result.structured.truncated, true);
	assert.match(result.content, /results omitted/);
});

test("formatSearch clips long page text and points at the fetch tool", () => {
	const withContent: SearchItem[] = [{ ...items[0], content: "x".repeat(500) }];
	const result = formatSearch("q", withContent, { ...options, contentMaxChars: 100 });
	assert.match(result.content, /-- page text --/);
	assert.match(result.content, /use web_fetch_ds for the full page/);
});

test("sliceContent pages deterministically and reports next offset", () => {
	const text = "abcdefghij";
	const first = sliceContent(text, 0, 4);
	assert.equal(first.text, "abcd");
	assert.equal(first.nextOffset, 4);

	const second = sliceContent(text, first.nextOffset ?? 0, 4);
	assert.equal(second.text, "efgh");
	assert.equal(second.nextOffset, 8);

	const last = sliceContent(text, 8, 4);
	assert.equal(last.text, "ij");
	assert.equal(last.nextOffset, null);
});

test("sliceContent never splits a surrogate pair", () => {
	const text = `a${"😀"}b`;
	const slice = sliceContent(text, 1, 1);
	assert.equal(slice.text, "😀");
	assert.equal(slice.offset, 1);
	assert.equal(slice.nextOffset, 3);
});

test("formatFetch omits the paging line when the whole page fits", () => {
	const result = formatFetch({ url: "https://example.com/p", title: "Page", content: "short page", offset: 0, maxChars: 1000 });
	assert.match(result.content, /^Page\nhttps:\/\/example\.com\/p\n---\nshort page$/);
	assert.ok(!result.content.includes("chars"));
	assert.ok(!result.content.includes("cache"));
	assert.equal(result.structured.next_offset, null);
});

test("formatFetch adds paging information only when there is more to read", () => {
	const content = "y".repeat(250);
	const first = formatFetch({ url: "https://example.com/p", title: "Page", content, offset: 0, maxChars: 100 });
	assert.match(first.content, /chars 0-100 of 250/);
	assert.match(first.content, /continue with offset=100/);
	assert.equal(first.structured.total_chars, 250);
	assert.equal(first.structured.returned_chars, 100);

	const second = formatFetch({ url: "https://example.com/p", title: "Page", content, offset: 100, maxChars: 100 });
	assert.equal(second.structured.offset, 100);
	assert.equal(second.structured.next_offset, 200);
});

test("formatFetch explains when offset is past the end", () => {
	const result = formatFetch({ url: "https://example.com/p", title: "Page", content: "abc", offset: 10, maxChars: 100 });
	assert.match(result.content, /is past the end/);
	assert.equal(result.structured.next_offset, null);
});
