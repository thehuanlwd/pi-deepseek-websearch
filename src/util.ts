import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

/** Write a file with 0600 permissions, replacing it atomically. */
export async function writeFileAtomic(path: string, data: string, mode = 0o600): Promise<void> {
	await ensureDir(dirname(path));
	const tmp = join(dirname(path), `.tmp-${randomBytes(6).toString("hex")}`);
	await writeFile(tmp, data, { encoding: "utf8", mode });
	try {
		await rename(tmp, path);
	} catch (error) {
		await unlink(tmp).catch(() => undefined);
		throw error;
	}
}

export function sha256Hex(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

export function shortHash(input: string, length = 16): string {
	return sha256Hex(input).slice(0, length);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Operation aborted"));
		};
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timer);
				reject(new Error("Operation aborted"));
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Replace a secret in a message so it cannot leak into the transcript or logs. */
export function redactSecret(text: string, secret: string | undefined): string {
	if (!secret) return text;
	return text.split(secret).join("[REDACTED]");
}

export function maskKey(secret: string): string {
	if (secret.length <= 8) return "••••";
	return `${secret.slice(0, 3)}••••${secret.slice(-4)}`;
}
