import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { websearchDir, type WebSearchConfig } from "./config.ts";
import {
	createPlaintextBackend,
	createSecretBackend,
	type SecretBackend,
	type SecretBackendName,
} from "./secret-backend.ts";
import { ensureDir, isRecord, maskKey, writeFileAtomic } from "./util.ts";

export type ProfileBackend = SecretBackendName | "memory";

export interface ProfileMeta {
	backend: ProfileBackend;
	last4: string;
	addedAt: string;
	validatedAt?: string;
}

export interface CredentialsFile {
	version: 1;
	defaultProfile?: string;
	profiles: Record<string, ProfileMeta>;
}

const EMPTY: CredentialsFile = { version: 1, profiles: {} };
const PROFILE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Decrypted secrets live in memory only and are cleared when the process ends. */
const memorySecrets = new Map<string, string>();
const backends = new Map<string, SecretBackend | undefined>();

export function secretsDir(agentDir: string): string {
	return join(websearchDir(agentDir), "secrets");
}

export function credentialsPath(agentDir: string): string {
	return join(websearchDir(agentDir), "credentials.json");
}

export function isValidProfileName(name: string): boolean {
	return PROFILE_PATTERN.test(name);
}

function memoryId(agentDir: string, profile: string): string {
	return `${agentDir}\u0000${profile}`;
}

function getBackend(agentDir: string, config: WebSearchConfig): SecretBackend | undefined {
	const cacheKey = `${agentDir}\u0000${config.allowPlaintextSecrets ? "plain" : "secure"}`;
	if (backends.has(cacheKey)) return backends.get(cacheKey);
	const backend = createSecretBackend(secretsDir(agentDir), { allowPlaintext: config.allowPlaintextSecrets });
	backends.set(cacheKey, backend);
	return backend;
}

export async function readCredentials(agentDir: string): Promise<CredentialsFile> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(credentialsPath(agentDir), "utf8"));
	} catch {
		return { ...EMPTY, profiles: {} };
	}
	if (!isRecord(raw) || !isRecord(raw.profiles)) return { ...EMPTY, profiles: {} };
	const profiles: Record<string, ProfileMeta> = {};
	for (const [name, value] of Object.entries(raw.profiles)) {
		if (!isRecord(value)) continue;
		const backend = value.backend;
		if (typeof backend !== "string") continue;
		if (!["dpapi", "macos-keychain", "secret-service", "plaintext", "memory"].includes(backend)) continue;
		profiles[name] = {
			backend: backend as ProfileBackend,
			last4: typeof value.last4 === "string" ? value.last4 : "",
			addedAt: typeof value.addedAt === "string" ? value.addedAt : "",
			validatedAt: typeof value.validatedAt === "string" ? value.validatedAt : undefined,
		};
	}
	return {
		version: 1,
		defaultProfile: typeof raw.defaultProfile === "string" ? raw.defaultProfile : undefined,
		profiles,
	};
}

export async function writeCredentials(agentDir: string, credentials: CredentialsFile): Promise<void> {
	await ensureDir(websearchDir(agentDir));
	await writeFileAtomic(credentialsPath(agentDir), `${JSON.stringify(credentials, null, 2)}\n`);
}

export async function getProfileSecret(
	agentDir: string,
	profile: string,
	config: WebSearchConfig,
): Promise<string | undefined> {
	const id = memoryId(agentDir, profile);
	const cached = memorySecrets.get(id);
	if (cached) return cached;

	const credentials = await readCredentials(agentDir);
	const meta = credentials.profiles[profile];
	if (!meta || meta.backend === "memory") return undefined;

	const backend = getBackend(agentDir, config);
	if (!backend) return undefined;

	try {
		const secret = await backend.get(profile);
		if (!secret) return undefined;
		memorySecrets.set(id, secret);
		return secret;
	} catch {
		return undefined;
	}
}

export interface SaveResult {
	persisted: boolean;
	backend: ProfileBackend;
	masked: string;
	warning?: string;
}

export async function saveProfileSecret(
	agentDir: string,
	profile: string,
	secret: string,
	config: WebSearchConfig,
): Promise<SaveResult> {
	const credentials = await readCredentials(agentDir);
	const backend = getBackend(agentDir, config);

	let backendName: ProfileBackend = "memory";
	let persisted = false;
	let warning: string | undefined;

	if (backend) {
		try {
			await backend.set(profile, secret);
			backendName = backend.name;
			persisted = true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (config.allowPlaintextSecrets && backend.name !== "plaintext") {
				try {
					await createPlaintextBackend(secretsDir(agentDir)).set(profile, secret);
					backendName = "plaintext";
					persisted = true;
					warning = `OS key store unavailable (${message}); saved as a 0600 plaintext file instead`;
				} catch (fallbackError) {
					const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
					warning = `Could not save the key (${message} / ${fallbackMessage}); it is valid for this session only`;
				}
			} else {
				warning = `Could not save the key (${message}); it is valid for this session only`;
			}
		}
	} else {
		warning = "No OS key store is available on this platform; the key is valid for this session only";
	}

	memorySecrets.set(memoryId(agentDir, profile), secret);

	credentials.profiles[profile] = {
		backend: backendName,
		last4: secret.slice(-4),
		addedAt: credentials.profiles[profile]?.addedAt ?? new Date().toISOString(),
		validatedAt: new Date().toISOString(),
	};
	if (!credentials.defaultProfile) credentials.defaultProfile = profile;
	await writeCredentials(agentDir, credentials);

	return { persisted, backend: backendName, masked: maskKey(secret), warning };
}

export async function deleteProfileSecret(
	agentDir: string,
	profile: string,
	config: WebSearchConfig,
): Promise<boolean> {
	const credentials = await readCredentials(agentDir);
	const meta = credentials.profiles[profile];
	memorySecrets.delete(memoryId(agentDir, profile));
	if (!meta) return false;

	if (meta.backend !== "memory") {
		const backend = getBackend(agentDir, config);
		if (backend) {
			try {
				await backend.delete(profile);
			} catch {
				// The keychain entry may already be gone; removing the metadata is still correct.
			}
		}
	}

	delete credentials.profiles[profile];
	if (credentials.defaultProfile === profile) {
		credentials.defaultProfile = Object.keys(credentials.profiles)[0];
	}
	await writeCredentials(agentDir, credentials);
	return true;
}

export async function setDefaultProfile(agentDir: string, profile: string): Promise<boolean> {
	const credentials = await readCredentials(agentDir);
	if (!credentials.profiles[profile]) return false;
	credentials.defaultProfile = profile;
	await writeCredentials(agentDir, credentials);
	return true;
}

export function clearSecretMemory(): void {
	memorySecrets.clear();
}

export function describeBackend(backend: ProfileBackend): string {
	switch (backend) {
		case "dpapi":
			return "Windows DPAPI";
		case "macos-keychain":
			return "macOS Keychain";
		case "secret-service":
			return "Secret Service";
		case "plaintext":
			return "plaintext file (0600)";
		default:
			return "memory only (lost on restart)";
	}
}
