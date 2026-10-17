import assert from "node:assert/strict";
import { test } from "node:test";
import { TtlCache } from "../src/cache.ts";

test("returns values until the ttl expires", () => {
	let now = 1000;
	const cache = new TtlCache<string>(10, () => now);
	cache.set("a", "v", 500);
	assert.equal(cache.get("a"), "v");
	now += 499;
	assert.equal(cache.get("a"), "v");
	now += 2;
	assert.equal(cache.get("a"), undefined);
	assert.equal(cache.stats().misses, 1);
	assert.equal(cache.stats().hits, 2);
});

test("evicts the least recently used entry beyond capacity", () => {
	const cache = new TtlCache<number>(2, () => 0);
	cache.set("a", 1, 1000);
	cache.set("b", 2, 1000);
	cache.get("a");
	cache.set("c", 3, 1000);
	assert.equal(cache.get("b"), undefined);
	assert.equal(cache.get("a"), 1);
	assert.equal(cache.get("c"), 3);
});

test("ignores non-positive ttls and supports delete/clear", () => {
	const cache = new TtlCache<number>(2, () => 0);
	cache.set("a", 1, 0);
	assert.equal(cache.get("a"), undefined);
	cache.set("a", 1, 1000);
	cache.delete("a");
	assert.equal(cache.get("a"), undefined);
	cache.set("a", 1, 1000);
	cache.clear();
	assert.equal(cache.stats().size, 0);
});
