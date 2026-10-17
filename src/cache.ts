export interface CacheStats {
	size: number;
	hits: number;
	misses: number;
}

interface Entry<V> {
	value: V;
	expiresAt: number;
}

/**
 * Small LRU + TTL cache. Requests are billed per successful DeepSeek call, so repeated
 * identical searches inside one session should not hit the network twice.
 */
export class TtlCache<V> {
	private readonly entries = new Map<string, Entry<V>>();
	private readonly maxEntries: number;
	private readonly now: () => number;
	private hits = 0;
	private misses = 0;

	constructor(maxEntries = 200, now: () => number = Date.now) {
		this.maxEntries = Math.max(1, maxEntries);
		this.now = now;
	}

	get(key: string): V | undefined {
		const entry = this.entries.get(key);
		if (!entry) {
			this.misses += 1;
			return undefined;
		}
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(key);
			this.misses += 1;
			return undefined;
		}
		// Refresh LRU position.
		this.entries.delete(key);
		this.entries.set(key, entry);
		this.hits += 1;
		return entry.value;
	}

	set(key: string, value: V, ttlMs: number): void {
		if (ttlMs <= 0) return;
		this.entries.delete(key);
		this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			this.entries.delete(oldest.value);
		}
	}

	has(key: string): boolean {
		return this.get(key) !== undefined;
	}

	delete(key: string): void {
		this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}

	stats(): CacheStats {
		return { size: this.entries.size, hits: this.hits, misses: this.misses };
	}
}
