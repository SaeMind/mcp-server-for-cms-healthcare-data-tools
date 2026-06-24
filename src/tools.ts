/**
 * @file tools.ts
 * @description MCP tool definitions and request handlers.
 *
 * Exposed tools:
 *  - list_datasets       → Return catalog of available CMS datasets
 *  - get_schema          → Return field schema for a dataset
 *  - get_data            → Retrieve filtered records from a dataset
 *  - run_query           → Execute a named query template with parameters
 *  - cache_status        → Return cache statistics
 *  - get_sample_queries  → Return example queries for a dataset
 *
 * Tool call lifecycle:
 *  1. Authenticate API key (if configured)
 *  2. Rate limit check
 *  3. Parameter validation (Zod schemas)
 *  4. Cache lookup
 *  5. Data fetch (demo or PostgreSQL)
 *  6. Cache store
 *  7. Audit log write
 *  8. Return typed JSON result
 */

import crypto from "crypto";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import { config } from "./config.js";
import { logger, writeAuditEntry, logQuery } from "./logger.js";
import {
  makeCacheKey,
  getCache,
  setCache,
  getCacheStats,
  getCacheTtlRemaining,
} from "./cache.js";
import {
  validateQueryParams,
  validateDatasetId,
  assertApprovedTemplate,
} from "./validators.js";
import {
  DATASET_CATALOG,
  fetchHccData,
  fetchReadmissionData,
  fetchMipsData,
  fetchPartdData,
} from "./datasources.js";
import type {
  DatasetId,
  HccQueryParams,
  ReadmissionQueryParams,
  MipsQueryParams,
  PartdQueryParams,
  QueryResult,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiter
// ─────────────────────────────────────────────────────────────────────────────

const rateLimiter = new RateLimiterMemory({
  points: config.RATE_LIMIT_REQUESTS_PER_MIN,
  duration: config.RATE_LIMIT_WINDOW_MS / 1000,
});

/**
 * Consume one rate-limit point for a given key (API key or "anonymous").
 *
 * @param key - Rate limit bucket identifier.
 * @throws Error with retry information if rate limit exceeded.
 */
async function checkRateLimit(key: string): Promise<void> {
  try {
    await rateLimiter.consume(key);
  } catch (err) {
    if (err instanceof RateLimiterRes) {
      const retryAfter = Math.ceil(err.msBeforeNext / 1000);
      throw new Error(
        `Rate limit exceeded. Retry after ${retryAfter}s. ` +
          `Limit: ${config.RATE_LIMIT_REQUESTS_PER_MIN} requests/min.`
      );
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate the MCP API key from request metadata.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param providedKey - Key from request headers or tool arguments.
 * @throws Error if key is missing or invalid (when MCP_API_KEY is configured).
 */
function validateApiKey(providedKey: string | undefined): void {
  if (!config.MCP_API_KEY) {
    return; // No key configured → open access (development/demo mode)
  }
  if (!providedKey) {
    throw new Error(
      "API key required. Pass x-api-key in request metadata or api_key in tool arguments."
    );
  }
  // Constant-time comparison prevents timing attacks
  const expected = Buffer.from(config.MCP_API_KEY);
  const provided = Buffer.from(providedKey);
  if (
    expected.length !== provided.length ||
    !crypto.timingSafeEqual(expected, provided)
  ) {
    throw new Error("Invalid API key.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON schemas for tool inputs (MCP spec requires JSON Schema)
// ─────────────────────────────────────────────────────────────────────────────

/** Reusable filter parameter definitions shared across query tools. */
const COMMON_FILTER_PROPERTIES = {
  start_date: {
    type: "string",
    description: "Start date filter (YYYY-MM-DD or YYYY-QN quarterly format)",
    pattern: "^\\d{4}(-\\d{2}-\\d{2}|-Q[1-4])?$",
  },
  end_date: {
    type: "string",
    description: "End date filter (YYYY-MM-DD or YYYY-QN)",
    pattern: "^\\d{4}(-\\d{2}-\\d{2}|-Q[1-4])?$",
  },
  state: {
    type: "string",
    description: "2-letter state FIPS code filter (e.g. TX, CA, NY)",
    pattern: "^[A-Z]{2}$",
  },
  limit: {
    type: "integer",
    description: "Maximum rows to return (1–1000, default 100)",
    minimum: 1,
    maximum: 1000,
    default: 100,
  },
  order_by: {
    type: "string",
    description: "Sort specification: 'field_name asc|desc' (e.g. 'risk_score desc')",
  },
};

/** MCP tool definitions (ListToolsResponse format). */
export const TOOL_DEFINITIONS = [
  {
    name: "list_datasets",
    description:
      "List all available CMS healthcare datasets with metadata including " +
      "source, update frequency, row count, key fields, and available filters. " +
      "Always call this first to understand what data is available.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: {
          type: "string",
          description: "API key (if server auth is enabled)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_schema",
    description:
      "Return the full field schema (names, types, descriptions, examples) " +
      "for a specific CMS dataset. Use this before get_data to understand " +
      "available fields and filter parameters.",
    inputSchema: {
      type: "object",
      properties: {
        dataset_id: {
          type: "string",
          description: "Dataset identifier",
          enum: [
            "hcc_risk_adjustment",
            "hospital_readmission",
            "mips_quality_measures",
            "partd_drug_utilization",
          ],
        },
        api_key: { type: "string" },
      },
      required: ["dataset_id"],
    },
  },
  {
    name: "get_data",
    description:
      "Retrieve filtered records from a CMS dataset. Supports filtering by " +
      "date range, geography, diagnosis codes, provider identifiers, and more. " +
      "Results are cached (24h for reference data, 5min for transactional). " +
      "Returns JSON with data lineage metadata.",
    inputSchema: {
      type: "object",
      properties: {
        dataset_id: {
          type: "string",
          description: "Target dataset",
          enum: [
            "hcc_risk_adjustment",
            "hospital_readmission",
            "mips_quality_measures",
            "partd_drug_utilization",
          ],
        },
        filters: {
          type: "object",
          description:
            "Dataset-specific filter parameters. Use get_schema to see " +
            "available filters for each dataset.",
          properties: {
            ...COMMON_FILTER_PROPERTIES,
            // HCC-specific
            icd_code: {
              type: "string",
              description:
                "ICD-10-CM diagnosis code (exact or prefix match, e.g. E11 for all Type 2 DM)",
            },
            hcc_category: {
              type: "integer",
              description: "HCC category number (e.g. 19 for diabetes w/o complication)",
            },
            min_risk_score: {
              type: "number",
              description: "Minimum relative risk factor (0.0–10.0)",
            },
            max_risk_score: {
              type: "number",
              description: "Maximum relative risk factor (0.0–10.0)",
            },
            model_year: {
              type: "integer",
              description: "CMS-HCC model year (e.g. 2024)",
            },
            // Readmission-specific
            hospital_ccn: {
              type: "string",
              description: "CMS Certification Number (6-digit hospital ID)",
            },
            hospital_name: {
              type: "string",
              description: "Hospital name (partial match)",
            },
            measure_id: {
              type: "string",
              description:
                "Quality measure ID (READM-30-AMI, READM-30-HF, READM-30-COPD, etc.)",
            },
            max_readmission_rate: {
              type: "number",
              description: "Maximum 30-day readmission rate (0.0–1.0)",
            },
            // MIPS-specific
            npi: {
              type: "string",
              description: "National Provider Identifier (10-digit NPI)",
            },
            specialty: {
              type: "string",
              description: "Provider specialty (partial match, e.g. Cardiology)",
            },
            min_performance_rate: {
              type: "number",
              description: "Minimum MIPS performance rate (0.0–1.0)",
            },
            // Part D-specific
            drug_name: {
              type: "string",
              description: "Generic or brand drug name (partial match)",
            },
            drug_class: {
              type: "string",
              description: "Drug class or therapeutic category (partial match)",
            },
            min_claims: {
              type: "integer",
              description: "Minimum total claims count",
            },
          },
        },
        api_key: { type: "string" },
      },
      required: ["dataset_id"],
    },
  },
  {
    name: "run_query",
    description:
      "Execute a pre-approved named query template with parameters. " +
      "Templates cover common RWE analyses: HCC grouping, readmission benchmarks, " +
      "MIPS performance summaries, drug cost trends. Use get_sample_queries to " +
      "see available templates.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: {
          type: "string",
          description: "Approved query template identifier",
          enum: [
            "hcc_by_icd_code",
            "hcc_by_category",
            "hcc_risk_score_distribution",
            "readmission_by_hospital",
            "readmission_by_state",
            "readmission_national_benchmark",
            "mips_performance_by_provider",
            "mips_performance_by_measure",
            "mips_specialty_summary",
            "partd_cost_by_drug",
            "partd_utilization_trends",
            "partd_top_drugs_by_cost",
          ],
        },
        parameters: {
          type: "object",
          description: "Template-specific parameter values",
          properties: COMMON_FILTER_PROPERTIES,
        },
        api_key: { type: "string" },
      },
      required: ["template_id"],
    },
  },
  {
    name: "cache_status",
    description:
      "Return current cache statistics: key count, hit/miss ratio, " +
      "memory usage. Useful for understanding whether responses are " +
      "served from cache vs live data.",
    inputSchema: {
      type: "object",
      properties: {
        api_key: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "get_sample_queries",
    description:
      "Return example queries and query templates for a given dataset. " +
      "Includes realistic RWE use cases with parameter examples.",
    inputSchema: {
      type: "object",
      properties: {
        dataset_id: {
          type: "string",
          description: "Dataset to get sample queries for",
          enum: [
            "hcc_risk_adjustment",
            "hospital_readmission",
            "mips_quality_measures",
            "partd_drug_utilization",
          ],
        },
        api_key: { type: "string" },
      },
      required: ["dataset_id"],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Dataset schemas (returned by get_schema tool)
// ─────────────────────────────────────────────────────────────────────────────

const DATASET_SCHEMAS: Record<DatasetId, Record<string, unknown>> = {
  hcc_risk_adjustment: {
    fields: [
      { name: "icdCode", type: "string", description: "ICD-10-CM diagnosis code", example: "E11.9" },
      { name: "icdDescription", type: "string", description: "ICD-10 code description", example: "Type 2 diabetes mellitus without complications" },
      { name: "hccCategory", type: "integer", description: "HCC category number", example: 19 },
      { name: "hccDescription", type: "string", description: "HCC category name", example: "Diabetes without Complication" },
      { name: "relativeFactorDual", type: "number", description: "Risk relative factor (dual-eligible beneficiaries)", example: 0.302 },
      { name: "relativeFactorNondual", type: "number", description: "Risk relative factor (non-dual beneficiaries)", example: 0.302 },
      { name: "modelYear", type: "integer", description: "CMS-HCC model year", example: 2024 },
      { name: "hierarchyGroup", type: "string", description: "Clinical hierarchy group", example: "Diabetes" },
    ],
  },
  hospital_readmission: {
    fields: [
      { name: "hospitalCcn", type: "string", description: "CMS Certification Number", example: "450289" },
      { name: "hospitalName", type: "string", description: "Hospital name", example: "Memorial Hermann Hospital" },
      { name: "state", type: "string", description: "State FIPS abbreviation", example: "TX" },
      { name: "measureId", type: "string", description: "AHRQ readmission measure ID", example: "READM-30-AMI" },
      { name: "measureName", type: "string", description: "Measure description", example: "30-Day AMI Readmission Rate" },
      { name: "denominator", type: "integer", description: "Eligible discharges", example: 423 },
      { name: "numerator", type: "integer", description: "Readmissions within 30 days", example: 58 },
      { name: "readmissionRate", type: "number", description: "Observed 30-day readmission rate", example: 0.137 },
      { name: "nationalRate", type: "number", description: "National benchmark rate", example: 0.152 },
      { name: "performanceCategory", type: "string", description: "better | same | worse | not_available", example: "better" },
      { name: "reportingPeriod", type: "string", description: "Data reporting window", example: "2022-07-01/2023-06-30" },
    ],
  },
  mips_quality_measures: {
    fields: [
      { name: "npi", type: "string", description: "National Provider Identifier (10 digits)", example: "1234567890" },
      { name: "providerName", type: "string", description: "Provider last, first name", example: "Smith, John A" },
      { name: "specialty", type: "string", description: "CMS specialty description", example: "Internal Medicine" },
      { name: "measureId", type: "string", description: "MIPS measure identifier", example: "001" },
      { name: "measureName", type: "string", description: "Measure full name", example: "Diabetes: Hemoglobin A1c Poor Control" },
      { name: "measureCategory", type: "string", description: "Clinical category", example: "Diabetes" },
      { name: "denominator", type: "integer", description: "Eligible patients", example: 145 },
      { name: "numerator", type: "integer", description: "Patients meeting measure criteria", example: 22 },
      { name: "performanceRate", type: "number", description: "Performance rate (numerator/denominator)", example: 0.152 },
      { name: "reportingYear", type: "integer", description: "MIPS performance year", example: 2023 },
      { name: "measureType", type: "string", description: "process | outcome | patient_experience | efficiency", example: "outcome" },
    ],
  },
  partd_drug_utilization: {
    fields: [
      { name: "drugName", type: "string", description: "Drug display name", example: "Metformin HCl" },
      { name: "genericName", type: "string", description: "Generic drug name", example: "metformin hydrochloride" },
      { name: "brandName", type: "string", description: "Brand drug name", example: "Glucophage" },
      { name: "drugClass", type: "string", description: "Drug class / therapeutic category", example: "Biguanides (Antidiabetics)" },
      { name: "totalClaims", type: "integer", description: "Total Part D claims", example: 89234 },
      { name: "totalBeneficiaries", type: "integer", description: "Unique Medicare beneficiaries", example: 67812 },
      { name: "totalDayCoverage", type: "integer", description: "Total days of drug coverage", example: 8921340 },
      { name: "totalDrugCost", type: "number", description: "Total drug cost (USD)", example: 4123450.0 },
      { name: "avgCostPerClaim", type: "number", description: "Average cost per claim (USD)", example: 46.21 },
      { name: "avgCostPerDay", type: "number", description: "Average cost per day supply (USD)", example: 0.46 },
      { name: "reportingYear", type: "integer", description: "Part D reporting year", example: 2022 },
      { name: "state", type: "string", description: "State FIPS abbreviation", example: "TX" },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Sample queries (returned by get_sample_queries tool)
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_QUERIES: Record<DatasetId, unknown[]> = {
  hcc_risk_adjustment: [
    {
      description: "Get all HCC categories for diabetes ICD-10 codes",
      tool: "get_data",
      arguments: { dataset_id: "hcc_risk_adjustment", filters: { icd_code: "E11", limit: 20 } },
    },
    {
      description: "Find high-risk HCC categories (relative factor > 0.5)",
      tool: "get_data",
      arguments: { dataset_id: "hcc_risk_adjustment", filters: { min_risk_score: 0.5, order_by: "relativeFactorNondual desc", limit: 10 } },
    },
    {
      description: "Get all cardiovascular HCC codes for 2024 model",
      tool: "get_data",
      arguments: { dataset_id: "hcc_risk_adjustment", filters: { hcc_category: 85, model_year: 2024 } },
    },
    {
      description: "Run HCC risk score distribution analysis",
      tool: "run_query",
      arguments: { template_id: "hcc_risk_score_distribution", parameters: { model_year: 2024 } },
    },
  ],
  hospital_readmission: [
    {
      description: "Get Texas hospitals with AMI readmission rates below 15%",
      tool: "get_data",
      arguments: { dataset_id: "hospital_readmission", filters: { state: "TX", measure_id: "READM-30-AMI", max_readmission_rate: 0.15 } },
    },
    {
      description: "Get readmission rates for Memorial Hermann Hospital",
      tool: "get_data",
      arguments: { dataset_id: "hospital_readmission", filters: { hospital_name: "Memorial Hermann" } },
    },
    {
      description: "Get national benchmark comparison by state",
      tool: "run_query",
      arguments: { template_id: "readmission_by_state", parameters: { state: "TX" } },
    },
    {
      description: "Find all hospitals performing better than national rate",
      tool: "get_data",
      arguments: { dataset_id: "hospital_readmission", filters: { measure_id: "READM-30-HF", max_readmission_rate: 0.2, order_by: "readmissionRate asc", limit: 25 } },
    },
  ],
  mips_quality_measures: [
    {
      description: "Get MIPS performance for a specific provider by NPI",
      tool: "get_data",
      arguments: { dataset_id: "mips_quality_measures", filters: { npi: "1234567890" } },
    },
    {
      description: "Find top-performing cardiologists on heart failure measures",
      tool: "get_data",
      arguments: { dataset_id: "mips_quality_measures", filters: { specialty: "Cardiology", measure_id: "005", min_performance_rate: 0.9 } },
    },
    {
      description: "Get specialty-level MIPS summary",
      tool: "run_query",
      arguments: { template_id: "mips_specialty_summary", parameters: {} },
    },
    {
      description: "Find all diabetes quality measures with performance > 80%",
      tool: "get_data",
      arguments: { dataset_id: "mips_quality_measures", filters: { min_performance_rate: 0.8, order_by: "performanceRate desc" } },
    },
  ],
  partd_drug_utilization: [
    {
      description: "Get Part D utilization for diabetes drugs in Texas",
      tool: "get_data",
      arguments: { dataset_id: "partd_drug_utilization", filters: { drug_class: "Antidiabetics", state: "TX", order_by: "totalDrugCost desc" } },
    },
    {
      description: "Find highest-cost drugs by average cost per claim",
      tool: "get_data",
      arguments: { dataset_id: "partd_drug_utilization", filters: { order_by: "avgCostPerClaim desc", limit: 10 } },
    },
    {
      description: "Compare statin utilization across states",
      tool: "run_query",
      arguments: { template_id: "partd_cost_by_drug", parameters: { drug_class: "Statins" } },
    },
    {
      description: "Get top 10 drugs by total Medicare spend",
      tool: "run_query",
      arguments: { template_id: "partd_top_drugs_by_cost", parameters: { limit: 10 } },
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Fetch dispatcher — routes get_data calls to the correct data source
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map snake_case filter keys to camelCase params expected by validators.
 */
function remapFilterKeys(
  filters: Record<string, unknown>
): Record<string, unknown> {
  const keyMap: Record<string, string> = {
    start_date: "startDate",
    end_date: "endDate",
    icd_code: "icdCode",
    hcc_category: "hccCategory",
    min_risk_score: "minRiskScore",
    max_risk_score: "maxRiskScore",
    model_year: "modelYear",
    hospital_ccn: "hospitalCcn",
    hospital_name: "hospitalName",
    measure_id: "measureId",
    max_readmission_rate: "maxReadmissionRate",
    min_performance_rate: "minPerformanceRate",
    prescriber_npi: "prescriberNpi",
    drug_name: "drugName",
    drug_class: "drugClass",
    min_claims: "minClaims",
    order_by: "orderBy",
  };

  return Object.fromEntries(
    Object.entries(filters).map(([k, v]) => [keyMap[k] ?? k, v])
  );
}

/**
 * Dispatch a get_data request to the appropriate CMS data connector.
 *
 * @param datasetId - Validated dataset identifier.
 * @param params - Validated query parameters (camelCase).
 * @param requestId - Trace ID.
 * @returns Typed QueryResult.
 */
async function dispatchDataFetch(
  datasetId: DatasetId,
  params: Record<string, unknown>,
  requestId: string
): Promise<QueryResult<Record<string, unknown>>> {
  switch (datasetId) {
    case "hcc_risk_adjustment":
      return fetchHccData(
        params as HccQueryParams,
        requestId
      ) as unknown as Promise<QueryResult<Record<string, unknown>>>;
    case "hospital_readmission":
      return fetchReadmissionData(
        params as ReadmissionQueryParams,
        requestId
      ) as unknown as Promise<QueryResult<Record<string, unknown>>>;
    case "mips_quality_measures":
      return fetchMipsData(
        params as MipsQueryParams,
        requestId
      ) as unknown as Promise<QueryResult<Record<string, unknown>>>;
    case "partd_drug_utilization":
      return fetchPartdData(
        params as PartdQueryParams,
        requestId
      ) as unknown as Promise<QueryResult<Record<string, unknown>>>;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool handlers — public interface called by server.ts
// ─────────────────────────────────────────────────────────────────────────────

/** Standard MCP tool response content item. */
interface ToolContent {
  type: "text";
  text: string;
}

/** MCP tool call result. */
interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/**
 * Format a value as indented JSON string for MCP text response.
 */
function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Build a success tool result.
 */
function successResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: toJson(data) }] };
}

/**
 * Build an error tool result.
 */
function errorResult(message: string, requestId?: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: toJson({ error: message, requestId }),
      },
    ],
    isError: true,
  };
}

/**
 * Handle the list_datasets tool call.
 *
 * @param args - Tool call arguments.
 * @param rateLimitKey - Identifier for rate limit bucket.
 * @returns MCP tool result with dataset catalog.
 */
export async function handleListDatasets(
  args: Record<string, unknown>,
  rateLimitKey: string
): Promise<ToolResult> {
  const requestId = crypto.randomUUID();
  const start = Date.now();

  try {
    validateApiKey(args.api_key as string | undefined);
    await checkRateLimit(rateLimitKey);

    const catalog = Object.values(DATASET_CATALOG);

    writeAuditEntry({
      requestId,
      timestamp: new Date().toISOString(),
      tool: "list_datasets",
      params: {},
      durationMs: Date.now() - start,
      rowsReturned: catalog.length,
      cacheHit: false,
    });

    return successResult({
      datasets: catalog,
      count: catalog.length,
      serverMode: config.DEMO_MODE ? "demo" : "production",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("list_datasets failed", { requestId, error: msg });
    return errorResult(msg, requestId);
  }
}

/**
 * Handle the get_schema tool call.
 *
 * @param args - Tool call arguments.
 * @param rateLimitKey - Rate limit bucket key.
 * @returns MCP tool result with field schema.
 */
export async function handleGetSchema(
  args: Record<string, unknown>,
  rateLimitKey: string
): Promise<ToolResult> {
  const requestId = crypto.randomUUID();

  try {
    validateApiKey(args.api_key as string | undefined);
    await checkRateLimit(rateLimitKey);
    const datasetId = validateDatasetId(args.dataset_id);

    return successResult({
      datasetId,
      metadata: DATASET_CATALOG[datasetId],
      schema: DATASET_SCHEMAS[datasetId],
    });
  } catch (err) {
    return errorResult(
      err instanceof Error ? err.message : String(err),
      requestId
    );
  }
}

/**
 * Handle the get_data tool call — the primary data retrieval interface.
 *
 * @param args - Tool call arguments including dataset_id and filters.
 * @param rateLimitKey - Rate limit bucket key.
 * @returns MCP tool result with query results.
 */
export async function handleGetData(
  args: Record<string, unknown>,
  rateLimitKey: string
): Promise<ToolResult> {
  const requestId = crypto.randomUUID();
  const start = Date.now();

  try {
    validateApiKey(args.api_key as string | undefined);
    await checkRateLimit(rateLimitKey);

    const datasetId = validateDatasetId(args.dataset_id);
    const rawFilters = (args.filters as Record<string, unknown>) ?? {};
    const mappedFilters = remapFilterKeys(rawFilters);

    // Validate parameters against dataset-specific schema
    const validation = validateQueryParams(datasetId, mappedFilters);
    if (!validation.success) {
      return errorResult(
        `Parameter validation failed:\n${validation.errors.join("\n")}`,
        requestId
      );
    }

    const params = validation.data as Record<string, unknown>;

    // Cache lookup
    const cacheKey = makeCacheKey(datasetId, params);
    const cached = getCache<Record<string, unknown>>(cacheKey);

    if (cached) {
      const ttlRemaining = getCacheTtlRemaining(cacheKey);
      cached.lineage.cacheHit = true;
      cached.lineage.cacheTtlRemainingSeconds = ttlRemaining;
      cached.requestId = requestId;

      writeAuditEntry({
        requestId,
        timestamp: new Date().toISOString(),
        tool: "get_data",
        datasetId,
        params: mappedFilters,
        durationMs: Date.now() - start,
        rowsReturned: cached.rowCount,
        cacheHit: true,
      });

      return successResult(cached);
    }

    // Fetch from data source
    const result = await dispatchDataFetch(datasetId, params, requestId);

    // Store in cache
    setCache(cacheKey, result, datasetId);

    const durationMs = Date.now() - start;
    logQuery(requestId, datasetId, mappedFilters, durationMs, result.rowCount);

    writeAuditEntry({
      requestId,
      timestamp: new Date().toISOString(),
      tool: "get_data",
      datasetId,
      params: mappedFilters,
      durationMs,
      rowsReturned: result.rowCount,
      cacheHit: false,
    });

    return successResult(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("get_data failed", { requestId, error: msg });
    return errorResult(msg, requestId);
  }
}

/**
 * Handle the run_query tool call — executes a named template.
 *
 * Template execution delegates to get_data with preset parameters
 * appropriate for the template's analytical intent.
 *
 * @param args - Tool call arguments with template_id and parameters.
 * @param rateLimitKey - Rate limit bucket key.
 * @returns MCP tool result with query results.
 */
export async function handleRunQuery(
  args: Record<string, unknown>,
  rateLimitKey: string
): Promise<ToolResult> {
  const requestId = crypto.randomUUID();

  try {
    validateApiKey(args.api_key as string | undefined);
    await checkRateLimit(rateLimitKey);

    const templateId = String(args.template_id ?? "");
    assertApprovedTemplate(templateId);

    const userParams = (args.parameters as Record<string, unknown>) ?? {};

    // Map template IDs to dataset + preset filters
    const templateMap: Record<
      string,
      { dataset_id: string; presets: Record<string, unknown> }
    > = {
      hcc_by_icd_code: { dataset_id: "hcc_risk_adjustment", presets: {} },
      hcc_by_category: { dataset_id: "hcc_risk_adjustment", presets: { order_by: "hccCategory asc" } },
      hcc_risk_score_distribution: { dataset_id: "hcc_risk_adjustment", presets: { order_by: "relativeFactorNondual desc", limit: 50 } },
      readmission_by_hospital: { dataset_id: "hospital_readmission", presets: { order_by: "readmissionRate asc" } },
      readmission_by_state: { dataset_id: "hospital_readmission", presets: {} },
      readmission_national_benchmark: { dataset_id: "hospital_readmission", presets: { order_by: "readmissionRate asc", limit: 100 } },
      mips_performance_by_provider: { dataset_id: "mips_quality_measures", presets: { order_by: "performanceRate desc" } },
      mips_performance_by_measure: { dataset_id: "mips_quality_measures", presets: { order_by: "performanceRate desc" } },
      mips_specialty_summary: { dataset_id: "mips_quality_measures", presets: { order_by: "performanceRate desc", limit: 50 } },
      partd_cost_by_drug: { dataset_id: "partd_drug_utilization", presets: { order_by: "totalDrugCost desc" } },
      partd_utilization_trends: { dataset_id: "partd_drug_utilization", presets: { order_by: "totalClaims desc" } },
      partd_top_drugs_by_cost: { dataset_id: "partd_drug_utilization", presets: { order_by: "avgCostPerClaim desc", limit: 10 } },
    };

    const template = templateMap[templateId];
    if (!template) {
      return errorResult(`Unknown template: ${templateId}`, requestId);
    }

    // Merge user params over presets (user params take precedence)
    const mergedFilters = { ...template.presets, ...userParams };

    return handleGetData(
      {
        dataset_id: template.dataset_id,
        filters: mergedFilters,
        api_key: args.api_key,
      },
      rateLimitKey
    );
  } catch (err) {
    return errorResult(
      err instanceof Error ? err.message : String(err),
      requestId
    );
  }
}

/**
 * Handle the cache_status tool call.
 *
 * @param args - Tool call arguments.
 * @param rateLimitKey - Rate limit bucket key.
 * @returns MCP tool result with cache statistics.
 */
export async function handleCacheStatus(
  args: Record<string, unknown>,
  rateLimitKey: string
): Promise<ToolResult> {
  const requestId = crypto.randomUUID();

  try {
    validateApiKey(args.api_key as string | undefined);
    await checkRateLimit(rateLimitKey);

    const stats = getCacheStats();

    return successResult({
      requestId,
      timestamp: new Date().toISOString(),
      cache: stats,
      ttlPolicy: {
        referenceDatasets: ["hcc_risk_adjustment", "mips_quality_measures"],
        referenceTtlSeconds: config.CACHE_TTL_REFERENCE,
        transactionalTtlSeconds: config.CACHE_TTL_TRANSACTION,
      },
    });
  } catch (err) {
    return errorResult(
      err instanceof Error ? err.message : String(err),
      requestId
    );
  }
}

/**
 * Handle the get_sample_queries tool call.
 *
 * @param args - Tool call arguments with dataset_id.
 * @param rateLimitKey - Rate limit bucket key.
 * @returns MCP tool result with example queries.
 */
export async function handleGetSampleQueries(
  args: Record<string, unknown>,
  rateLimitKey: string
): Promise<ToolResult> {
  const requestId = crypto.randomUUID();

  try {
    validateApiKey(args.api_key as string | undefined);
    await checkRateLimit(rateLimitKey);

    const datasetId = validateDatasetId(args.dataset_id);
    const samples = SAMPLE_QUERIES[datasetId];

    return successResult({
      datasetId,
      sampleQueries: samples,
      hint: "Pass these arguments directly to the tool named in each sample.",
    });
  } catch (err) {
    return errorResult(
      err instanceof Error ? err.message : String(err),
      requestId
    );
  }
}
