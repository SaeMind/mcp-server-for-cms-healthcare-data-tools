/**
 * @file config.ts
 * @description Environment configuration loader with runtime validation via Zod.
 *
 * All secrets must be injected via environment variables or a .env file.
 * Never hardcode credentials in source code.
 */

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

/** Zod schema for full server configuration. */
const ConfigSchema = z.object({
  /** HTTP port for health/metrics endpoints. MCP runs over stdio, not HTTP. */
  PORT: z
    .string()
    .regex(/^\d+$/, "PORT must be numeric")
    .transform(Number)
    .default("3000"),

  /** API key for authenticating tool call requests. Empty string == no auth required. */
  MCP_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),

  /** Enable demo mode (embedded sample data, no DB or external APIs required). */
  DEMO_MODE: z
    .string()
    .transform((v) => v.toLowerCase() === "true")
    .default("true"),

  /** PostgreSQL connection URL (required when DEMO_MODE=false). */
  DATABASE_URL: z
    .string()
    .url()
    .optional()
    .describe("postgresql://user:pass@host:port/db"),

  /** Max PostgreSQL pool connections. */
  DB_POOL_MAX: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .default("10"),

  /** Idle connection timeout (ms). */
  DB_POOL_IDLE_TIMEOUT_MS: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .default("30000"),

  /** Reference data cache TTL (seconds): HCC grouper, MIPS measures, drug schedules. */
  CACHE_TTL_REFERENCE: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .default("86400"),

  /** Transactional data cache TTL (seconds): readmission rates, cost trends. */
  CACHE_TTL_TRANSACTION: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .default("300"),

  /** Max requests per window per API key. */
  RATE_LIMIT_REQUESTS_PER_MIN: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .default("100"),

  /** Rate limit window size (ms). */
  RATE_LIMIT_WINDOW_MS: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .default("60000"),

  /** Minimum log level emitted. */
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),

  /** CMS Provider Data API base URL. */
  CMS_PROVIDER_DATA_BASE_URL: z
    .string()
    .url()
    .default("https://data.cms.gov/provider-data/api/1"),

  /** CMS Open Data API base URL. */
  CMS_DATA_BASE_URL: z
    .string()
    .url()
    .default("https://data.cms.gov/data-api/v1"),

  /** Directory for audit and query logs. */
  AUDIT_LOG_PATH: z.string().default("./outputs/audit.log"),
  QUERY_LOG_PATH: z.string().default("./outputs/queries.log"),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Load and validate server configuration from environment.
 *
 * @throws {Error} If required fields are missing or fail validation.
 * @returns {Config} Validated configuration object.
 */
export function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuration validation failed:\n${issues}`);
  }

  // Enforce DATABASE_URL when not in demo mode
  if (!result.data.DEMO_MODE && !result.data.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required when DEMO_MODE=false. " +
        "Set DATABASE_URL or enable DEMO_MODE=true."
    );
  }

  return result.data;
}

/** Singleton config instance. Parsed once at startup. */
export const config = loadConfig();
