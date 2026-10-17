/**
 * Tool-path probe: loads the extension with a fake pi runtime (no model calls) and executes
 * web_search_ds / web_fetch_ds against a local mock of the DeepSeek API.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hits = { search: 0, fetch: 0, models: 0 };
let lastSearchBody: Record<string, unknown> | undefined;

const server = createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (chunk: Buffer) => chunks.push(chunk));
	req.on("end", () => {
		const body = Buffer.concat(chunks).toString("utf8");
		if (req.url === "/v1/tools/search") {
			hits.search += 1;
			lastSearchBody = JSON.parse(body) as Record<string, unknown>;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					results: [
						{
							rerank_score: 2.4,
							title: "DeepSeek V4 发布",
							url: "https://example.com/v4",
							snippet: "短摘要",
							summary: "长摘要：DeepSeek V4 已发布，改进了工具调用。",
							content: "",
							site_name: "Example",
							date: "2026-06-01T00:00:00+00:00",
							authority: 3,
						},
					],
				}),
			);
			return;
		}
		if (req.url === "/v1/tools/fetch") {
			hits.fetch += 1;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ title: "Example article", content: "# Example\n\n" + "body ".repeat(400) }));
			return;
		}
		if (req.url === "/models") {
			hits.models += 1;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [] }));
			return;
		}
		res.writeHead(404).end();
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("bind failed");
const baseUrl = `http://127.0.0.1:${address.port}`;

const agentDir = await mkdtemp(join(tmpdir(), "pi-ds-toolflow-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_DEEPSEEK_WEBSEARCH_BASE_URL = baseUrl;
delete process.env.DEEPSEEK_API_KEY;

interface RegisteredTool {
	name: string;
	description: string;
	execute: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<{
		content: Array<{ type: string; text: string }>;
		structuredContent: Record<string, any>;
	}>;
}

interface FakePi {
	tools: Map<string, RegisteredTool>;
	commands: Map<string, unknown>;
	events: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>;
	foreignTool: { name: string; description: string; sourceInfo: { path: string } } | undefined;
	api: {
		registerTool: (definition: RegisteredTool) => void;
		registerCommand: (name: string, definition: unknown) => void;
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => () => void;
		getAllTools: () => Array<{ name: string; description: string; sourceInfo: { path: string }; exposure: string }>;
		getActiveTools: () => string[];
	};
}

function createFakePi(): FakePi {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, unknown>();
	const events = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
	const fake: FakePi = {
		tools,
		commands,
		events,
		foreignTool: undefined,
		api: {
			registerTool: (definition) => tools.set(definition.name, definition),
			registerCommand: (name, definition) => commands.set(name, definition),
			on: (event, handler) => {
				const list = events.get(event) ?? [];
				list.push(handler);
				events.set(event, list);
				return () => undefined;
			},
			getAllTools: () =>
				[...tools.values()].map((tool) =>
					fake.foreignTool && fake.foreignTool.name === tool.name
						? { name: tool.name, description: fake.foreignTool.description, sourceInfo: fake.foreignTool.sourceInfo, exposure: "direct" }
						: { name: tool.name, description: tool.description, sourceInfo: { path: "D:/repo/pi-deepseek-websearch/src/index.ts" }, exposure: "direct" },
				),
			getActiveTools: () => [...tools.keys()],
		},
	};
	return fake;
}

function makeCtx(notified: string[], options: { hasUI: boolean; mode: string; key?: string }): unknown {
	return {
		hasUI: options.hasUI,
		mode: options.mode,
		cwd: process.cwd(),
		modelRegistry: { getApiKeyForProvider: async () => options.key },
		sessionManager: { getBranch: () => [] },
		ui: {
			notify: (message: string) => notified.push(message),
			setStatus: () => undefined,
			input: async () => undefined,
		},
	};
}

const fake = createFakePi();
const module = await import("../src/index.ts");
await module.default(fake.api);

assert.deepEqual([...fake.tools.keys()].sort(), ["web_fetch_ds", "web_search_ds"]);
assert.deepEqual([...fake.commands.keys()].sort(), ["web-key", "web-status"]);

const notified: string[] = [];
const ctx = makeCtx(notified, { hasUI: false, mode: "print", key: "sk-from-pi-auth" });

const search = fake.tools.get("web_search_ds")!;
const fetchTool = fake.tools.get("web_fetch_ds")!;

const searchResult = await search.execute("call-1", { query: "DeepSeek V4", count: 3 }, undefined, undefined, ctx);
const searchText = searchResult.content[0].text;
assert.match(searchText, /DeepSeek V4 发布/);
assert.match(searchText, /https:\/\/example\.com\/v4/);
assert.ok(!/¥|cache|QPS/i.test(searchText), "search result must not carry billing/cache noise");
assert.equal(searchResult.structuredContent.count, 1);
assert.equal(searchResult.structuredContent.results[0].site_name, "Example");
assert.equal(hits.search, 1);
assert.equal(lastSearchBody?.query, "DeepSeek V4");
assert.equal(lastSearchBody?.count, 3);

// Second identical search is served from the session cache (no second billed request).
const second = await search.execute("call-2", { query: "DeepSeek V4", count: 3 }, undefined, undefined, ctx);
assert.equal(hits.search, 1);
assert.equal(second.structuredContent.count, 1);
assert.ok(!("cached" in second.structuredContent));

// fresh: true bypasses the cache.
await search.execute("call-3", { query: "DeepSeek V4", count: 3, fresh: true }, undefined, undefined, ctx);
assert.equal(hits.search, 2);

// Fetch pages from the session cache without another billed request.
const firstPage = await fetchTool.execute("call-4", { url: "https://example.com/a", max_chars: 600 }, undefined, undefined, ctx);
assert.match(firstPage.content[0].text, /Example article/);
assert.match(firstPage.content[0].text, /continue with offset=600/);
assert.equal(hits.fetch, 1);
assert.equal(firstPage.structuredContent.returned_chars, 600);

const nextPage = await fetchTool.execute(
	"call-5",
	{ url: "https://example.com/a", offset: firstPage.structuredContent.next_offset, max_chars: 600 },
	undefined,
	undefined,
	ctx,
);
assert.equal(hits.fetch, 1);
assert.equal(nextPage.structuredContent.offset, 600);

// Invalid URLs are rejected before any request.
await assert.rejects(() => fetchTool.execute("call-6", { url: "ftp://example.com/a" }, undefined, undefined, ctx), /http\/https/);
await assert.rejects(
	() => fetchTool.execute("call-7", { url: "https://user:pass@example.com/a" }, undefined, undefined, ctx),
	/username or password/,
);

// Without a key and without UI, the tool fails with actionable guidance.
const noKeyCtx = makeCtx([], { hasUI: false, mode: "print" });
await assert.rejects(
	() => search.execute("call-8", { query: "x" }, undefined, undefined, noKeyCtx),
	/DEEPSEEK_API_KEY|web-key/,
);

// Name collision: another extension already owns web_search_ds. pi drops ours silently, so the
// extension must warn instead of looking broken.
const collisionNotified: string[] = [];
const collisionPi = createFakePi();
collisionPi.foreignTool = {
	name: "web_search_ds",
	description: "A completely different web search implementation",
	sourceInfo: { path: "D:/repo/pi-web-access/src/index.ts" },
};
await module.default(collisionPi.api);
const sessionStart = collisionPi.events.get("session_start")?.[0];
assert.ok(sessionStart, "session_start handler missing");
await sessionStart(
	{ type: "session_start", reason: "startup" },
	makeCtx(collisionNotified, { hasUI: true, mode: "print", key: "sk-test" }),
);
assert.ok(
	collisionNotified.some((message) => message.includes("is owned by")),
	`expected a collision warning, got: ${JSON.stringify(collisionNotified)}`,
);

// First-run prompt (TUI only): capture the dialog text users actually see.
const promptNotified: string[] = [];
let promptTitle = "";
let promptPlaceholder = "";
const tuiCtx = {
	hasUI: true,
	mode: "tui",
	cwd: process.cwd(),
	modelRegistry: { getApiKeyForProvider: async () => undefined },
	sessionManager: { getBranch: () => [] },
	ui: {
		notify: (message: string) => promptNotified.push(message),
		setStatus: () => undefined,
		input: async (title: string, placeholder?: string) => {
			promptTitle = title;
			promptPlaceholder = placeholder ?? "";
			return undefined;
		},
	},
};
const tuiSessionStart = fake.events.get("session_start")?.[0];
assert.ok(tuiSessionStart, "session_start handler missing");
await tuiSessionStart({ type: "session_start", reason: "startup" }, tuiCtx);
assert.ok(promptTitle.includes("installed"), `prompt should say the service is installed: ${promptTitle}`);
assert.ok(promptTitle.includes("https://platform.deepseek.com/api_keys"), `prompt should include the key URL: ${promptTitle}`);
assert.ok(promptTitle.includes("web_search_ds") && promptTitle.includes("web_fetch_ds"), `prompt should name the tools: ${promptTitle}`);
assert.equal(promptPlaceholder, "sk-...");
assert.ok(!promptTitle.includes("platform.deepseek.com/api_keys 获取") && !/[一-鿿]/.test(promptTitle), "prompt must be plain English");
assert.ok(
	promptNotified.some((message) => message.includes("Skipped the DeepSeek API key prompt")),
	`skipping should be explained: ${JSON.stringify(promptNotified)}`,
);
// Skipping must not nag again on the next start.
const afterSkip = JSON.parse(await readFile(join(agentDir, "websearch", "config.json"), "utf8"));
assert.equal(afterSkip.promptOnStartup, false);

// Renaming through config.json works (load order: config is read at factory start).
await mkdir(join(agentDir, "websearch"), { recursive: true });
await writeFile(
	join(agentDir, "websearch", "config.json"),
	JSON.stringify({ searchToolName: "deepseek_web_search", fetchToolName: "deepseek_web_fetch" }, null, 2),
);
const renamed = createFakePi();
const renamedModule = await import("../src/index.ts?rename=1");
await renamedModule.default(renamed.api);
assert.deepEqual([...renamed.tools.keys()].sort(), ["deepseek_web_fetch", "deepseek_web_search"]);

console.log(
	JSON.stringify(
		{
			ok: true,
			hits,
			defaultTools: [...fake.tools.keys()].sort(),
			renamedTools: [...renamed.tools.keys()].sort(),
			collisionWarning: collisionNotified.find((message) => message.includes("is owned by")),
			prompt: promptTitle,
			searchBytes: searchText.length,
			fetchPreview: firstPage.content[0].text.split("\n").slice(0, 3),
		},
		null,
		2,
	),
);

server.close();
await rm(agentDir, { recursive: true, force: true });
