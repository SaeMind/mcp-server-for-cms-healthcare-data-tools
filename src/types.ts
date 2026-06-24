/**
 * @file types.ts
 * @description Shared TypeScript interfaces and types for the CMS MCP Server.
 *
 * All domain types are derived from official CMS data specifications:
 * - HCC V28 Risk Adjustment Model (CMS-HCC)
 * - HCUP AHRQ Readmission Measures
 * - CMS MIPS Quality Payment Program
 * - Medicare Part D Drug Utilization
 */

// ─────────────────────────────────────────────────────────────────────────────
// Dataset registry
// ─────────────────────────────────────────────────────────────────────────────

/** Identifiers for all supported CMS data sources. */
export type DatasetId =
  | "hcc_risk_adjustment"
  | "hospital_readmission"
  | "mips_quality_measures"
  | "partd_drug_utilization";

/** Metadata record for a single dataset in the catalog. */
export interface DatasetMetadata {
  id: DatasetId;
  name: string;
  description: string;
  source: string;
  updateFrequency: "quarterly" | "annual" | "monthly" | "daily";
  lastUpdated: string;
  rowCount: number;
  keyFields: string[];
  availableFilters: string[];
  cacheTtlSeconds: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query interface
// ─────────────────────────────────────────────────────────────────────────────

/** Supported aggregation dimensions. */
export type AggregationDimension =
  | "diagnosis_category"
  | "geography"
  | "provider_specialty"
  | "service_line"
  | "drug_class"
  | "measure_category";

/** Supported sort directions. */
export type SortDirection = "asc" | "desc";

/** Common filter parameters shared across all datasets. */
export interface BaseQueryParams {
  /** Start date (ISO 8601: YYYY-MM-DD or YYYY-Q[1-4]). */
  startDate?: string;
  /** End date (ISO 8601). */
  endDate?: string;
  /** State or territory FIPS code (2-letter abbreviation). */
  state?: string;
  /** Maximum rows to return (1–1000, default 100). */
  limit?: number;
  /** Aggregation dimension. */
  aggregateBy?: AggregationDimension;
  /** Sort field and direction, e.g. "risk_score desc". */
  orderBy?: string;
}

/** Parameters specific to HCC risk adjustment queries. */
export interface HccQueryParams extends BaseQueryParams {
  /** ICD-10-CM diagnosis code (exact or prefix match). */
  icdCode?: string;
  /** HCC category number (e.g. 18 for diabetes). */
  hccCategory?: number;
  /** Minimum risk score (0.0–10.0). */
  minRiskScore?: number;
  /** Maximum risk score. */
  maxRiskScore?: number;
  /** Model year (e.g. 2024). */
  modelYear?: number;
}

/** Parameters specific to hospital readmission queries. */
export interface ReadmissionQueryParams extends BaseQueryParams {
  /** Hospital CCN (CMS Certification Number). */
  hospitalCcn?: string;
  /** Hospital name (partial match). */
  hospitalName?: string;
  /** AHRQ readmission measure ID (e.g. "READM-30-AMI"). */
  measureId?: string;
  /** Maximum 30-day readmission rate (0.0–1.0). */
  maxReadmissionRate?: number;
}

/** Parameters specific to MIPS quality measure queries. */
export interface MipsQueryParams extends BaseQueryParams {
  /** National Provider Identifier. */
  npi?: string;
  /** MIPS measure ID (e.g. "001" for diabetes eye exam). */
  measureId?: string;
  /** Provider specialty code. */
  specialty?: string;
  /** Minimum performance rate (0.0–1.0). */
  minPerformanceRate?: number;
}

/** Parameters specific to Part D drug utilization queries. */
export interface PartdQueryParams extends BaseQueryParams {
  /** Generic drug name (partial match). */
  drugName?: string;
  /** Drug class (ATC code or description). */
  drugClass?: string;
  /** Prescriber NPI. */
  prescriberNpi?: string;
  /** Minimum total claims count. */
  minClaims?: number;
}

/** Union of all dataset-specific query parameters. */
export type QueryParams =
  | HccQueryParams
  | ReadmissionQueryParams
  | MipsQueryParams
  | PartdQueryParams;

/** Validated, sanitized query ready for execution. */
export interface ValidatedQuery {
  datasetId: DatasetId;
  params: QueryParams;
  requestId: string;
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────────────────────────────────────

/** Provenance metadata attached to every data response. */
export interface DataLineage {
  source: string;
  sourceUrl: string;
  dataVersion: string;
  lastUpdated: string;
  retrievedAt: string;
  cacheHit: boolean;
  cacheTtlRemainingSeconds?: number;
}

/** Standardized wrapper for all query results. */
export interface QueryResult<T = Record<string, unknown>> {
  requestId: string;
  datasetId: DatasetId;
  rowCount: number;
  rows: T[];
  lineage: DataLineage;
  warnings?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain entity types
// ─────────────────────────────────────────────────────────────────────────────

/** HCC risk adjustment record (CMS-HCC V28). */
export interface HccRecord {
  icdCode: string;
  icdDescription: string;
  hccCategory: number;
  hccDescription: string;
  relativeFactorDual: number;
  relativeFactorNondual: number;
  modelYear: number;
  hierarchyGroup: string;
}

/** Hospital readmission record (HCUP AHRQ). */
export interface ReadmissionRecord {
  hospitalCcn: string;
  hospitalName: string;
  state: string;
  measureId: string;
  measureName: string;
  denominator: number;
  numerator: number;
  readmissionRate: number;
  nationalRate: number;
  performanceCategory: "worse" | "same" | "better" | "not_available";
  reportingPeriod: string;
}

/** MIPS quality measure performance record. */
export interface MipsRecord {
  npi: string;
  providerName: string;
  specialty: string;
  measureId: string;
  measureName: string;
  measureCategory: string;
  denominator: number;
  numerator: number;
  performanceRate: number;
  reportingYear: number;
  measureType: "process" | "outcome" | "patient_experience" | "efficiency";
}

/** Part D drug utilization record. */
export interface PartdRecord {
  drugName: string;
  genericName: string;
  brandName: string;
  drugClass: string;
  totalClaims: number;
  totalBeneficiaries: number;
  totalDayCoverage: number;
  totalDrugCost: number;
  avgCostPerClaim: number;
  avgCostPerDay: number;
  reportingYear: number;
  state: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Security / audit
// ─────────────────────────────────────────────────────────────────────────────

/** Audit log entry written for every tool call. */
export interface AuditEntry {
  requestId: string;
  timestamp: string;
  tool: string;
  datasetId?: DatasetId;
  params: Record<string, unknown>;
  durationMs: number;
  rowsReturned: number;
  cacheHit: boolean;
  error?: string;
}

/** Rate limiter key type. */
export type RateLimitKey = string;

// ─────────────────────────────────────────────────────────────────────────────
// Cache types
// ─────────────────────────────────────────────────────────────────────────────

/** Cache statistics returned by the cache_status tool. */
export interface CacheStats {
  keys: number;
  hits: number;
  misses: number;
  hitRatio: number;
  vsize: number;
  ksize: number;
}
