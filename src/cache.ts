/**
 * @file cache.ts
 * @description In-memory caching layer for CMS query results.
 *
 * Two TTL tiers:
 *  - Reference data  (HCC grouper, MIPS measures): 24h — data is static within a year
 *  - Transactional   (readmission rates, cost data): 5min — data changes quarterly
 *
 * Cache keys are deterministic hashes of (datasetId + serialized params) to
 * ensure identical queries share cache entries.
 *
 * In production, replace NodeCache with Redis for distributed deployments.
 */

import NodeCache from "node-cache";
import crypto from "crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { DatasetId, QueryResult, CacheStats } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// TTL routing
// ─────────────────────────────────────────────────────────────────────────────

/** Datasets whose data changes rarely — use longer TTL. */
const REFERENCE_DATASETS: Set<DatasetId> = new Set([
  "hcc_risk_adjustment",
  "mips_quality_measures",
]);

/**
 * Return the appropriate cache TTL (seconds) for a given dataset.
 *
 * @param datasetId - CMS dataset identifier.
 * @returns TTL in seconds.
 */
function getTtl(datasetId: DatasetId): number {
  return REFERENCE_DATASETS.has(datasetId)
    ? config.CACHE_TTL_REFERENCE
    : config.CACHE_TTL_TRANSACTION;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache instance
// ─────────────────────────────────────────────────────────────────────────────

const cache = new NodeCache({
  stdTTL: config.CACHE_TTL_REFERENCE,
  checkperiod: 120,
  useClones: true, // defensive copy on get/set
  deleteOnExpire: true,
});

// Instrument cache events
cache.on("set", (key: string) => logger.debug("cache:set", { key }));
cache.on("del", (key: string) => logger.debug("cache:del", { key }));
cache.on("expired", (key: string) => logger.debug("cache:expired", { key }));

// ─────────────────────────────────────────────────────────────────────────────
// Cache utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a deterministic cache key from dataset ID and query parameters.
 *
 * Uses SHA-256 of the canonical JSON string to produce a fixed-length key
 * regardless of parameter object size.
 *
 * @param datasetId - CMS dataset identifier.
 * @param params - Query parameters (will be canonicalized before hashing).
 * @returns 16-character hex cache key prefixed with dataset ID.
 */
export function makeCacheKey(
  datasetId: DatasetId,
  params: Record<string, unknown>
): string {
  // Sort keys for determinism — {a:1,b:2} and {b:2,a:1} must produce same hash
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null)
        .sort(([a], [b]) => a.localeCompare(b))
    )
  );

  const hash = crypto
    .createHash("sha256")
    .update(`${datasetId}:${canonical}`)
    .digest("hex")
    .slice(0, 16);

  return `${datasetId}:${hash}`;
}

/**
 * Retrieve a cached query result.
 *
 * @param key - Cache key from makeCacheKey().
 * @returns Cached QueryResult or undefined on miss.
 */
export function getCache<T>(key: string): QueryResult<T> | undefined {
  const value = cache.get<QueryResult<T>>(key);
  if (value !== undefined) {
    logger.debug("cache:hit", { key });
    return value;
  }
  logger.debug("cache:miss", { key });
  return undefined;
}

/**
 * Store a query result in cache.
 *
 * @param key - Cache key from makeCacheKey().
 * @param value - Query result to cache.
 * @param datasetId - Used to select appropriate TTL tier.
 * @returns true if stored successfully.
 */
export function setCache<T>(
  key: string,
  value: QueryResult<T>,
  datasetId: DatasetId
): boolean {
  const ttl = getTtl(datasetId);
  const success = cache.set(key, value, ttl);
  logger.debug("cache:stored", { key, ttlSeconds: ttl, success });
  return success;
}

/**
 * Invalidate a specific cache entry.
 *
 * @param key - Cache key to delete.
 */
export function invalidateCache(key: string): void {
  cache.del(key);
  logger.info("cache:invalidated", { key });
}

/**
 * Return remaining TTL for a cache entry in seconds.
 *
 * @param key - Cache key.
 * @returns Remaining TTL in seconds, or 0 if not found.
 */
export function getCacheTtlRemaining(key: string): number {
  const ttl = cache.getTtl(key);
  if (ttl === undefined || ttl === 0) return 0;
  const remainingMs = ttl - Date.now();
  return remainingMs > 0 ? Math.floor(remainingMs / 1000) : 0;
}

/**
 * Return aggregate cache statistics for the cache_status tool.
 *
 * @returns Cache hit/miss ratio and memory usage stats.
 */
export function getCacheStats(): CacheStats {
  const stats = cache.getStats();
  const hitRatio =
    stats.hits + stats.misses > 0
      ? stats.hits / (stats.hits + stats.misses)
      : 0;

  return {
    keys: cache.keys().length,
    hits: stats.hits,
    misses: stats.misses,
    hitRatio: Math.round(hitRatio * 10000) / 100, // percentage, 2dp
    vsize: stats.vsize,
    ksize: stats.ksize,
  };
}

/**
 * Flush all cache entries. Used in tests and for admin operations.
 */
export function flushCache(): void {
  cache.flushAll();
  logger.warn("cache:flushed", { message: "All cache entries cleared" });
}
