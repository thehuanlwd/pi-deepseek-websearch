import { spawn } from "node:child_process";

/**
 * Runs a short-lived helper process and captures its output. Used for OS secret stores
 * (DPAPI via PowerShell, macOS `security`, Linux `secret-tool`).
 */
export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	input?: string;
	timeoutMs?: number;
}

export function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (error: Error | undefined, result?: CommandResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (error) reject(error);
			else resolve(result as CommandResult);
		};

		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new Error(`Command timed out after ${options.timeoutMs ?? 20000}ms: ${command}`));
		}, options.timeoutMs ?? 20000);

		child.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("close", (code) =>
			finish(undefined, {
				code: code ?? -1,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			}),
		);

		if (options.input !== undefined) child.stdin.write(options.input);
		child.stdin.end();
	});
}
