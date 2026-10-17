/**
 * End-to-end key flow probe (no model calls):
 * 1. starts a local mock of the DeepSeek API
 * 2. launches `pi --mode rpc` with a throwaway agent dir and the mock base URL
 * 3. runs `/web-key sk-...` and asserts the key was validated, encrypted and stored
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_KEY = "sk-integration-test-key-1234567890";

const server = createServer((req, res) => {
	if (req.url === "/models") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [] }));
		return;
	}
	if (req.url === "/user/balance") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				is_available: true,
				balance_infos: [{ currency: "CNY", total_balance: "9.99", granted_balance: "0.00", topped_up_balance: "9.99" }],
			}),
		);
		return;
	}
	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { message: "not found" } }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server bind failed");
const baseUrl = `http://127.0.0.1:${address.port}`;

const agentDir = await mkdtemp(join(tmpdir(), "pi-ds-agent-"));
const extPath = process.argv[2] ?? "./pi-deepseek-websearch";

function spawnPi() {
	const args = ["--mode", "rpc", "--no-session", "--no-mcp", "-e", extPath];
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_DEEPSEEK_WEBSEARCH_BASE_URL: baseUrl,
	};
	return process.platform === "win32"
		? spawn("cmd.exe", ["/d", "/s", "/c", "pi", ...args], { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true })
		: spawn("pi", args, { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true });
}

const child = spawnPi();
const notifies = [];
let buffer = "";
let finished = false;

const finish = async (code) => {
	if (finished) return;
	finished = true;
	child.kill();
	server.close();
	await rm(agentDir, { recursive: true, force: true }).catch(() => undefined);
	console.log(JSON.stringify({ code, notifies }, null, 2));
	process.exit(code);
};

child.stdout.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		if (!line) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record.type === "extension_ui_request" && record.method === "notify") {
			notifies.push(record.message);
			if (String(record.message).includes("DeepSeek API key saved")) void verify();
			if (String(record.message).includes("Invalid profile name")) void finish(1);
		}
	}
});

let stderrText = "";
child.stderr.on("data", (chunk) => {
	stderrText += chunk.toString("utf8");
});

async function verify() {
	try {
		const credentials = JSON.parse(await readFile(join(agentDir, "websearch", "credentials.json"), "utf8"));
		const profiles = credentials.profiles ?? {};
		const meta = profiles.default;
		if (!meta) throw new Error("profile 'default' was not written");
		if (meta.last4 !== API_KEY.slice(-4)) throw new Error(`unexpected last4: ${meta.last4}`);
		if (meta.backend !== "dpapi") throw new Error(`expected dpapi backend, got ${meta.backend}`);

		const secretFiles = await readdir(join(agentDir, "websearch", "secrets"));
		if (secretFiles.length !== 1) throw new Error(`expected one secret file, found ${secretFiles.length}`);
		const blob = await readFile(join(agentDir, "websearch", "secrets", secretFiles[0]), "utf8");
		if (blob.includes(API_KEY)) throw new Error("secret file contains the plaintext key");
		if (blob.includes("sk-")) throw new Error("secret file looks like plaintext");

		console.error(`OK: backend=${meta.backend}, last4=${meta.last4}, secret bytes=${blob.trim().length}`);
		await finish(0);
	} catch (error) {
		console.error("VERIFY FAILED:", error instanceof Error ? error.message : error);
		console.error(stderrText.slice(-2000));
		await finish(1);
	}
}

setTimeout(() => child.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: `/web-key ${API_KEY}` })}\n`), 2500);
setTimeout(() => {
	console.error("TIMEOUT. notifies=", notifies);
	console.error(stderrText.slice(-2000));
	void finish(2);
}, 20000);
