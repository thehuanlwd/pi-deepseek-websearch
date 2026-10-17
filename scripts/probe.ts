/**
 * Smoke probe: start pi in RPC mode with the extension loaded, ask for state and commands,
 * and print what pi reports. No model call, so it costs nothing.
 */
import { spawn } from "node:child_process";

const extPath = process.argv[2] ?? "./pi-deepseek-websearch";

const args = ["--mode", "rpc", "--no-session", "--no-mcp", "-e", extPath];
const child =
	process.platform === "win32"
		? spawn("cmd.exe", ["/d", "/s", "/c", "pi", ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
		: spawn("pi", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

let buffer = "";
const state = { commands: undefined, tools: undefined };
const seen = [];
const ui = [];
let finished = false;

function send(obj) {
	child.stdin.write(`${JSON.stringify(obj)}\n`);
}

function finish(code) {
	if (finished) return;
	finished = true;
	child.kill();
	console.log("=== commands ===");
	console.log(JSON.stringify(state.commands, null, 2));
	console.log("=== tool names ===");
	console.log(JSON.stringify(state.tools, null, 2));
	console.log("=== extension ui requests ===");
	console.log(JSON.stringify(ui, null, 2));
	console.log("=== stderr (first 40 lines) ===");
	child.stderr.destroy();
	console.log("=== stderr tail ===");
	console.log(stderrText.slice(-3000));
	process.exit(code);
}

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
		seen.push(record);
		if (record.type === "extension_ui_request") {
			ui.push({ method: record.method, message: record.message, status: record.status });
		}
		if (record.type === "response" && record.command === "get_commands") {
			state.commands = (record.data?.commands ?? []).map((c) => c.name).filter((n) => String(n).startsWith("web"));
		}
		if (record.type === "response" && record.command === "get_state") {
			const data = record.data ?? {};
			const tools = data.tools ?? data.activeTools ?? data.session?.tools;
			state.tools = Array.isArray(tools) ? tools : Object.keys(data);
		}
		if (state.commands !== undefined && state.tools !== undefined && ui.some((r) => String(r.message ?? "").includes("Current key"))) finish(0);
	}
});

let stderrText = "";
child.stderr.on("data", (chunk) => {
	stderrText += chunk.toString("utf8");
	if (stderrText.length > 20000) stderrText = stderrText.slice(-10000);
});

child.on("exit", (code) => {
	if (!finished) {
		console.error("pi exited early with code", code);
		console.error(stderrText.slice(-4000));
		finish(1);
	}
});

setTimeout(() => {
	send({ id: "1", type: "get_state" });
	setTimeout(() => send({ id: "2", type: "get_commands" }), 300);
	setTimeout(() => send({ id: "3", type: "prompt", message: "/web-key status" }), 900);
}, 2500);

setTimeout(() => {
	console.error("timeout; stderr tail:\n" + stderrText.slice(-4000));
	finish(2);
}, 15000);
