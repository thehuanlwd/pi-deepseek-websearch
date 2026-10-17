import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { DeepSeekHttpError, DeepSeekWebClient, RateLimiter, validateApiKey } from "../src/deepseek.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>;

async function withServer(handler: Handler, run: (baseUrl: string) => Promise<void>): Promise<void> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			void handler(req, res, Buffer.concat(chunks).toString("utf8"));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("failed to bind test server");
	try {
		await run(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

const fastLimiter = () => new RateLimiter(100000);

test("search sends auth, count and ori_question, and normalizes results", async () => {
	let seenAuth: string | undefined;
	let seenBody: Record<string, unknown> | undefined;

	await withServer(
		(req, res, body) => {
			seenAuth = req.headers.authorization;
			seenBody = JSON.parse(body) as Record<string, unknown>;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					results: [
						{
							rerank_score: 2.4,
							title: "T",
							url: "https://example.com",
							snippet: "S",
							summary: "SUM",
							content: "",
							site_name: "Example",
							site_icon: null,
							date: "2026-06-01T00:00:00+00:00",
							authority: 3,
						},
					],
				}),
			);
		},
		async (baseUrl) => {
			const client = new DeepSeekWebClient("sk-test", {
				baseUrl,
				limiter: fastLimiter(),
				sleepImpl: async () => undefined,
			});
			const results = await client.search({ query: "deepseek", count: 5, needContent: false, oriQuestion: "what is deepseek" });
			assert.equal(results.length, 1);
			assert.equal(results[0].title, "T");
			assert.equal(results[0].siteName, "Example");
			assert.equal(results[0].authority, 3);
			assert.equal(results[0].rerankScore, 2.4);
		},
	);

	assert.equal(seenAuth, "Bearer sk-test");
	assert.equal(seenBody?.query, "deepseek");
	assert.equal(seenBody?.count, 5);
	assert.equal(seenBody?.need_content, false);
	assert.equal(seenBody?.ori_question, "what is deepseek");
});

test("401 surfaces an actionable hint and is not retried", async () => {
	let attempts = 0;
	await withServer(
		(_req, res) => {
			attempts += 1;
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "Authentication Fails (invalid key)", type: "authentication_error" } }));
		},
		async (baseUrl) => {
			const client = new DeepSeekWebClient("sk-bad", { baseUrl, limiter: fastLimiter(), sleepImpl: async () => undefined });
			await assert.rejects(
				() => client.search({ query: "x", count: 1, needContent: false }),
				(error: unknown) => {
					assert.ok(error instanceof DeepSeekHttpError);
					assert.equal(error.status, 401);
					assert.match(error.message, /\/web-key/);
					return true;
				},
			);
		},
	);
	assert.equal(attempts, 1);
});

test("429 is retried after backoff and then succeeds", async () => {
	let attempts = 0;
	const delays: number[] = [];
	await withServer(
		(_req, res) => {
			attempts += 1;
			if (attempts === 1) {
				res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
				res.end(JSON.stringify({ error: { message: "rate limited" } }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ results: [] }));
		},
		async (baseUrl) => {
			const client = new DeepSeekWebClient("sk-test", {
				baseUrl,
				limiter: fastLimiter(),
				sleepImpl: async (ms) => {
					delays.push(ms);
				},
			});
			const results = await client.search({ query: "x", count: 1, needContent: false });
			assert.deepEqual(results, []);
		},
	);
	assert.equal(attempts, 2);
	assert.deepEqual(delays, [1000]);
});

test("5xx is retried up to maxRetries and then fails", async () => {
	let attempts = 0;
	await withServer(
		(_req, res) => {
			attempts += 1;
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "boom" } }));
		},
		async (baseUrl) => {
			const client = new DeepSeekWebClient("sk-test", {
				baseUrl,
				limiter: fastLimiter(),
				sleepImpl: async () => undefined,
				maxRetries: 2,
			});
			await assert.rejects(() => client.search({ query: "x", count: 1, needContent: false }), (error: unknown) => {
				assert.ok(error instanceof DeepSeekHttpError);
				assert.equal(error.status, 500);
				return true;
			});
		},
	);
	assert.equal(attempts, 3);
});

test("fetchPage returns markdown and treats an empty body as 404", async () => {
	let mode: "ok" | "empty" = "ok";
	await withServer(
		(_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			if (mode === "ok") res.end(JSON.stringify({ title: "Example", content: "# Example\n\nHello" }));
			else res.end(JSON.stringify({ title: "", content: "   " }));
		},
		async (baseUrl) => {
			const client = new DeepSeekWebClient("sk-test", { baseUrl, limiter: fastLimiter(), sleepImpl: async () => undefined });
			const page = await client.fetchPage("https://example.com");
			assert.equal(page.title, "Example");
			assert.match(page.content, /# Example/);

			mode = "empty";
			await assert.rejects(
				() => client.fetchPage("https://example.com/none"),
				(error: unknown) => {
					assert.ok(error instanceof DeepSeekHttpError);
					assert.equal(error.status, 404);
					return true;
				},
			);
		},
	);
});

test("validateApiKey distinguishes success, invalid key and network failure", async () => {
	let status = 200;
	await withServer(
		(_req, res) => {
			if (status === 0) {
				res.destroy();
				return;
			}
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [] }));
		},
		async (baseUrl) => {
			assert.equal((await validateApiKey("sk-test", { baseUrl })).ok, true);

			status = 401;
			const invalid = await validateApiKey("sk-test", { baseUrl });
			assert.equal(invalid.ok, false);
			assert.equal(invalid.status, 401);

			status = 0;
			const broken = await validateApiKey("sk-test", { baseUrl });
			assert.equal(broken.ok, false);
			assert.equal(broken.status, 0);
		},
	);
});

test("RateLimiter spaces acquires to the configured qps", async () => {
	let now = 0;
	const waits: number[] = [];
	const limiter = new RateLimiter(
		4,
		() => now,
		async (ms) => {
			waits.push(ms);
			now += ms;
		},
	);
	await limiter.acquire();
	await limiter.acquire();
	await limiter.acquire();
	assert.deepEqual(waits, [250, 250]);
});
