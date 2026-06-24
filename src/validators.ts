/**
 * @file validators.ts
 * @description Query parameter validation and SQL injection prevention.
 *
 * Security model:
 *  1. All parameters are validated against strict Zod schemas before use.
 *  2. Only pre-approved SQL templates are executed — no dynamic SQL construction.
 *  3. ICD-10, NPI, and FIPS codes are validated against known-good patterns.
 *  4. String parameters are length-capped and stripped of SQL meta-characters.
 *  5. Every query must match an approved template ID; ad-hoc SQL is rejected.
 *
 * Validation errors return structured messages, never raw stack traces.
 */

import { z } from "zod";
import type { DatasetId } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Regex patterns for healthcare identifiers
// ─────────────────────────────────────────────────────────────────────────────

/** ICD-10-CM code: 3-7 alphanumeric characters, optional decimal after 3rd char. */
const ICD10_PATTERN = /^[A-Z][0-9A-Z]{1,2}(\.[0-9A-Z]{1,4})?$/i;

/** NPI: exactly 10 digits. */
const NPI_PATTERN = /^\d{10}$/;

/** FIPS state code: 2 uppercase letters. */
const STATE_PATTERN = /^[A-Z]{2}$/;

/** CMS Certification Number (CCN): 6 digits. */
const CCN_PATTERN = /^\d{6}$/;

/** ISO date: YYYY-MM-DD or YYYY-QN quarterly format. */
const DATE_PATTERN = /^\d{4}(-\d{2}-\d{2}|-Q[1-4])?$/;

/** MIPS measure ID: 3-digit zero-padded string, optional suffix. */
const MIPS_MEASURE_PATTERN = /^\d{3}[A-Z]?$/;

/** AHRQ readmission measure ID. */
const READM_MEASURE_PATTERN = /^READM-\d{2}-[A-Z0-9-]+$/;

// ─────────────────────────────────────────────────────────────────────────────
// Sanitization helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip characters that could escape parameterized SQL contexts.
 * Defense-in-depth: parameterized queries already prevent injection,
 * but sanitizing ensures clean logging and no unexpected behavior.
 *
 * @param input - Raw string from tool call parameters.
 * @param maxLength - Maximum allowed string length (default 256).
 * @returns Sanitized string.
 */
function sanitizeString(input: string, maxLength = 256): string {
  return input
    .slice(0, maxLength)
    .replace(/['";\\%_-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared base schema
// ─────────────────────────────────────────────────────────────────────────────

const BaseParamsSchema = z.object({
  startDate: z
    .string()
    .regex(DATE_PATTERN, "startDate must be YYYY-MM-DD or YYYY-QN")
    .optional(),
  endDate: z
    .string()
    .regex(DATE_PATTERN, "endDate must be YYYY-MM-DD or YYYY-QN")
    .optional(),
  state: z
    .string()
    .regex(STATE_PATTERN, "state must be 2-letter FIPS code (e.g. TX, CA)")
    .optional(),
  limit: z
    .number()
    .int()
    .min(1, "limit must be >= 1")
    .max(1000, "limit cannot exceed 1000")
    .default(100),
  aggregateBy: z
    .enum([
      "diagnosis_category",
      "geography",
      "provider_specialty",
      "service_line",
      "drug_class",
      "measure_category",
    ])
    .optional(),
  orderBy: z
    .string()
    .max(64)
    .regex(
      /^[a-z_]+ (asc|desc)$/i,
      "orderBy must be 'field_name asc|desc'"
    )
    .optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Dataset-specific schemas
// ─────────────────────────────────────────────────────────────────────────────

export const HccParamsSchema = BaseParamsSchema.extend({
  icdCode: z
    .string()
    .regex(ICD10_PATTERN, "Invalid ICD-10-CM code format")
    .transform((v) => v.toUpperCase())
    .optional(),
  hccCategory: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional(),
  minRiskScore: z.number().min(0).max(10).optional(),
  maxRiskScore: z.number().min(0).max(10).optional(),
  modelYear: z
    .number()
    .int()
    .min(2019)
    .max(2030)
    .optional(),
}).refine(
  (d) =>
    d.minRiskScore === undefined ||
    d.maxRiskScore === undefined ||
    d.minRiskScore <= d.maxRiskScore,
  { message: "minRiskScore must be <= maxRiskScore", path: ["minRiskScore"] }
);

export const ReadmissionParamsSchema = BaseParamsSchema.extend({
  hospitalCcn: z
    .string()
    .regex(CCN_PATTERN, "hospitalCcn must be 6 digits")
    .optional(),
  hospitalName: z
    .string()
    .max(128)
    .transform((val) => sanitizeString(val))
    .optional(),
  measureId: z
    .string()
    .regex(
      READM_MEASURE_PATTERN,
      "measureId must match READM-NN-XXXXX (e.g. READM-30-AMI)"
    )
    .optional(),
  maxReadmissionRate: z.number().min(0).max(1).optional(),
});

export const MipsParamsSchema = BaseParamsSchema.extend({
  npi: z
    .string()
    .regex(NPI_PATTERN, "NPI must be exactly 10 digits")
    .optional(),
  measureId: z
    .string()
    .regex(MIPS_MEASURE_PATTERN, "measureId must be 3-digit MIPS measure ID")
    .optional(),
  specialty: z
    .string()
    .max(64)
    .transform((val) => sanitizeString(val))
    .optional(),
  minPerformanceRate: z.number().min(0).max(1).optional(),
});

export const PartdParamsSchema = BaseParamsSchema.extend({
  drugName: z
    .string()
    .max(128)
    .transform((val) => sanitizeString(val))
    .optional(),
  drugClass: z
    .string()
    .max(64)
    .transform((val) => sanitizeString(val))
    .optional(),
  prescriberNpi: z
    .string()
    .regex(NPI_PATTERN, "prescriberNpi must be exactly 10 digits")
    .optional(),
  minClaims: z.number().int().min(0).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation dispatch
// ─────────────────────────────────────────────────────────────────────────────

/** Map dataset IDs to their Zod schemas. */
const SCHEMA_MAP = {
  hcc_risk_adjustment: HccParamsSchema,
  hospital_readmission: ReadmissionParamsSchema,
  mips_quality_measures: MipsParamsSchema,
  partd_drug_utilization: PartdParamsSchema,
} as const satisfies Record<DatasetId, z.ZodTypeAny>;

/** Result of parameter validation. */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: string[] };

/**
 * Validate and coerce query parameters for a given dataset.
 *
 * Uses dataset-specific Zod schema to validate, coerce types, and
 * apply range/format constraints. Returns structured errors on failure
 * instead of throwing, so the MCP tool handler can return a user-friendly
 * error message.
 *
 * @param datasetId - Target CMS dataset.
 * @param rawParams - Raw parameters from tool call arguments.
 * @returns Validated params or array of error messages.
 */
export function validateQueryParams<T>(
  datasetId: DatasetId,
  rawParams: unknown
): ValidationResult<T> {
  const schema = SCHEMA_MAP[datasetId];
  const result = schema.safeParse(rawParams);

  if (!result.success) {
    const errors = result.error.issues.map(
      (i) => `${i.path.join(".") || "root"}: ${i.message}`
    );
    return { success: false, errors };
  }

  return { success: true, data: result.data as T };
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL template whitelist
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Approved SQL query template IDs. Only these identifiers are executable.
 * The actual SQL templates live in datasources.ts alongside their parameter
 * substitution logic to prevent template injection.
 */
export const APPROVED_QUERY_TEMPLATES: ReadonlySet<string> = new Set([
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
]);

/**
 * Validate that a template ID is in the approved whitelist.
 *
 * @param templateId - Template identifier from tool call.
 * @returns true if approved.
 * @throws Error if not in whitelist — rejected immediately.
 */
export function assertApprovedTemplate(templateId: string): void {
  if (!APPROVED_QUERY_TEMPLATES.has(templateId)) {
    throw new Error(
      `Query template '${templateId}' is not approved. ` +
        `Approved templates: ${[...APPROVED_QUERY_TEMPLATES].join(", ")}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dataset ID validator
// ─────────────────────────────────────────────────────────────────────────────

const VALID_DATASET_IDS: ReadonlySet<DatasetId> = new Set([
  "hcc_risk_adjustment",
  "hospital_readmission",
  "mips_quality_measures",
  "partd_drug_utilization",
]);

/**
 * Validate that a dataset ID is one of the supported values.
 *
 * @param id - Dataset identifier from tool call.
 * @returns Typed DatasetId or throws on invalid.
 */
export function validateDatasetId(id: unknown): DatasetId {
  if (typeof id !== "string" || !VALID_DATASET_IDS.has(id as DatasetId)) {
    throw new Error(
      `Invalid dataset_id '${String(id)}'. ` +
        `Valid options: ${[...VALID_DATASET_IDS].join(", ")}`
    );
  }
  return id as DatasetId;
}
