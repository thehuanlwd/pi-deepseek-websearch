import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./command.ts";
import { ensureDir, shortHash, writeFileAtomic } from "./util.ts";

export type SecretBackendName = "dpapi" | "macos-keychain" | "secret-service" | "plaintext";

export interface SecretBackend {
	readonly name: SecretBackendName;
	get(id: string): Promise<string | undefined>;
	set(id: string, secret: string): Promise<void>;
	delete(id: string): Promise<void>;
}

const SERVICE = "pi-deepseek-websearch";
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

/**
 * Windows DPAPI (CurrentUser) via PowerShell. The secret travels over stdin as base64 and
 * is never placed on the command line, so it cannot be read from the process list.
 */
const PS_ENCRYPT = [
	"$ErrorActionPreference='Stop'",
	"Add-Type -AssemblyName System.Security",
	"$b64=[Console]::In.ReadToEnd().Trim()",
	"$data=[Convert]::FromBase64String($b64)",
	"$enc=[System.Security.Cryptography.ProtectedData]::Protect($data,$null,'CurrentUser')",
	"[Console]::Out.Write([Convert]::ToBase64String($enc))",
].join("; ");

const PS_DECRYPT = [
	"$ErrorActionPreference='Stop'",
	"Add-Type -AssemblyName System.Security",
	"$b64=[Console]::In.ReadToEnd().Trim()",
	"$data=[Convert]::FromBase64String($b64)",
	"$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($data,$null,'CurrentUser')",
	"[Console]::Out.Write([Convert]::ToBase64String($plain))",
].join("; ");

async function runPowerShell(script: string, input: string): Promise<string> {
	let lastError: Error | undefined;
	for (const binary of ["powershell.exe", "pwsh.exe", "powershell", "pwsh"]) {
		try {
			const result = await runCommand(binary, [...PS_ARGS, script], { input, timeoutMs: 20000 });
			if (result.code !== 0) {
				lastError = new Error(`PowerShell exited with ${result.code}: ${result.stderr.trim()}`);
				continue;
			}
			return result.stdout;
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}
	throw lastError ?? new Error("PowerShell is not available");
}

export class DpapiBackend implements SecretBackend {
	readonly name = "dpapi" as const;
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private file(id: string): string {
		return join(this.dir, `${shortHash(id)}.dpapi`);
	}

	async get(id: string): Promise<string | undefined> {
		let blob: string;
		try {
			blob = (await readFile(this.file(id), "utf8")).trim();
		} catch {
			return undefined;
		}
		if (!blob) return undefined;
		const encoded = (await runPowerShell(PS_DECRYPT, blob)).trim();
		if (!encoded) throw new Error("DPAPI returned an empty secret");
		return Buffer.from(encoded, "base64").toString("utf8");
	}

	async set(id: string, secret: string): Promise<void> {
		const encodedInput = Buffer.from(secret, "utf8").toString("base64");
		const encoded = (await runPowerShell(PS_ENCRYPT, encodedInput)).trim();
		if (!encoded) throw new Error("DPAPI encryption returned no data");
		await ensureDir(this.dir);
		await writeFileAtomic(this.file(id), encoded);
	}

	async delete(id: string): Promise<void> {
		await rm(this.file(id), { force: true });
	}
}

/** macOS Keychain. `security` takes the secret as an argument, so it is briefly visible to `ps`. */
export class MacKeychainBackend implements SecretBackend {
	readonly name = "macos-keychain" as const;

	constructor(_dir: string) {}

	async get(id: string): Promise<string | undefined> {
		const result = await runCommand("security", ["find-generic-password", "-s", SERVICE, "-a", id, "-w"], {
			timeoutMs: 10000,
		});
		if (result.code !== 0) return undefined;
		const secret = result.stdout.trim();
		return secret || undefined;
	}

	async set(id: string, secret: string): Promise<void> {
		const result = await runCommand(
			"security",
			["add-generic-password", "-U", "-s", SERVICE, "-a", id, "-w", secret],
			{ timeoutMs: 10000 },
		);
		if (result.code !== 0) throw new Error(`Keychain write failed: ${result.stderr.trim()}`);
	}

	async delete(id: string): Promise<void> {
		await runCommand("security", ["delete-generic-password", "-s", SERVICE, "-a", id], { timeoutMs: 10000 });
	}
}

/** Linux Secret Service (gnome-keyring, KWallet). The secret arrives over stdin. */
export class SecretServiceBackend implements SecretBackend {
	readonly name = "secret-service" as const;

	constructor(_dir: string) {}

	private attrs(id: string): string[] {
		return ["service", SERVICE, "account", id];
	}

	async get(id: string): Promise<string | undefined> {
		const result = await runCommand("secret-tool", ["lookup", ...this.attrs(id)], { timeoutMs: 10000 });
		if (result.code !== 0) return undefined;
		const secret = result.stdout.trim();
		return secret || undefined;
	}

	async set(id: string, secret: string): Promise<void> {
		const result = await runCommand(
			"secret-tool",
			["store", "--label", `${SERVICE} (${id})`, ...this.attrs(id)],
			{ input: secret, timeoutMs: 10000 },
		);
		if (result.code !== 0) throw new Error(`secret-tool failed: ${result.stderr.trim()}`);
	}

	async delete(id: string): Promise<void> {
		await runCommand("secret-tool", ["clear", ...this.attrs(id)], { timeoutMs: 10000 });
	}
}

/** Last resort: a 0600 file next to the metadata. Only used when explicitly allowed. */
export class PlaintextBackend implements SecretBackend {
	readonly name = "plaintext" as const;
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private file(id: string): string {
		return join(this.dir, `${shortHash(id)}.plain`);
	}

	async get(id: string): Promise<string | undefined> {
		try {
			const secret = (await readFile(this.file(id), "utf8")).trim();
			return secret || undefined;
		} catch {
			return undefined;
		}
	}

	async set(id: string, secret: string): Promise<void> {
		await ensureDir(this.dir);
		await writeFileAtomic(this.file(id), secret);
	}

	async delete(id: string): Promise<void> {
		await rm(this.file(id), { force: true });
	}
}

export interface BackendOptions {
	allowPlaintext: boolean;
}

export function createSecretBackend(secretsDir: string, options: BackendOptions): SecretBackend | undefined {
	const platform = process.platform;
	if (platform === "win32") return new DpapiBackend(secretsDir);
	if (platform === "darwin") return new MacKeychainBackend(secretsDir);
	if (platform === "linux") return new SecretServiceBackend(secretsDir);
	return options.allowPlaintext ? new PlaintextBackend(secretsDir) : undefined;
}

export function createPlaintextBackend(secretsDir: string): SecretBackend {
	return new PlaintextBackend(secretsDir);
}
