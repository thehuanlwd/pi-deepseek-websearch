import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	deleteProfileSecret,
	getProfileSecret,
	readCredentials,
	saveProfileSecret,
	setDefaultProfile,
	clearSecretMemory,
} from "../src/credentials.ts";
import { DpapiBackend, PlaintextBackend } from "../src/secret-backend.ts";

async function tempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "pi-ds-websearch-"));
}

test("PlaintextBackend stores 0600 files and deletes them", async () => {
	const dir = await tempDir();
	try {
		const backend = new PlaintextBackend(dir);
		await backend.set("default", "sk-plain-secret");
		assert.equal(await backend.get("default"), "sk-plain-secret");

		const file = join(dir, `${(await import("../src/util.ts")).shortHash("default")}.plain`);
		if (process.platform !== "win32") {
			const mode = (await stat(file)).mode & 0o777;
			assert.equal(mode, 0o600);
		}

		await backend.delete("default");
		assert.equal(await backend.get("default"), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("DPAPI round-trips a secret without writing it in clear text", { skip: process.platform !== "win32" }, async () => {
	const dir = await tempDir();
	try {
		const backend = new DpapiBackend(dir);
		const secret = "sk-dpapi-roundtrip-1234567890";
		await backend.set("default", secret);
		assert.equal(await backend.get("default"), secret);

		const files = await import("node:fs/promises").then((fs) => fs.readdir(dir));
		assert.equal(files.length, 1);
		const raw = await readFile(join(dir, files[0]), "utf8");
		assert.ok(!raw.includes(secret), "ciphertext must not contain the plaintext secret");

		await backend.delete("default");
		assert.equal(await backend.get("default"), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("profile metadata keeps only a hint of the key and tracks the default profile", async () => {
	const agentDir = await tempDir();
	const config = { ...DEFAULT_CONFIG, allowPlaintextSecrets: true };
	clearSecretMemory();
	try {
		const saved = await saveProfileSecret(agentDir, "default", "sk-first-key-abcdef", config);
		assert.equal(saved.masked.includes("cdef"), true);
		assert.equal(saved.persisted, true);

		await saveProfileSecret(agentDir, "work", "sk-second-key-xyz", config);
		assert.equal(await setDefaultProfile(agentDir, "work"), true);

		const credentials = await readCredentials(agentDir);
		assert.equal(credentials.defaultProfile, "work");
		assert.deepEqual(Object.keys(credentials.profiles).sort(), ["default", "work"]);
		assert.ok(!JSON.stringify(credentials).includes("sk-first-key"));

		clearSecretMemory();
		assert.equal(await getProfileSecret(agentDir, "default", config), "sk-first-key-abcdef");

		clearSecretMemory();
		assert.equal(await deleteProfileSecret(agentDir, "work", config), true);
		const after = await readCredentials(agentDir);
		assert.equal(after.defaultProfile, "default");
		assert.deepEqual(Object.keys(after.profiles), ["default"]);
	} finally {
		clearSecretMemory();
		await rm(agentDir, { recursive: true, force: true });
	}
});
