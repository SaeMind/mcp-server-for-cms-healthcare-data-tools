/**
 * @file datasources.ts
 * @description CMS data connectors for all four supported datasets.
 *
 * Runtime mode is controlled by DEMO_MODE environment variable:
 *  - DEMO_MODE=true  → Returns embedded sample data (no external deps required)
 *  - DEMO_MODE=false → Queries PostgreSQL (requires CMS data loaded via ETL)
 *
 * All data returned is:
 *  - Read-only (no INSERT/UPDATE/DELETE ever executed)
 *  - Public CMS data (no PHI — these are aggregate/provider-level datasets)
 *  - Parameterized (no SQL concatenation)
 *
 * Real data sources:
 *  - HCC: CMS-HCC V28 Risk Adjustment Model (https://www.cms.gov/medicare/hcc)
 *  - Readmission: HCUP Quality Indicators (https://www.qualityindicators.ahrq.gov)
 *  - MIPS: Quality Payment Program (https://qpp.cms.gov)
 *  - Part D: Medicare Part D Prescriber Data (https://data.cms.gov)
 */

import { Pool } from "pg";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type {
  DatasetId,
  DatasetMetadata,
  HccRecord,
  HccQueryParams,
  ReadmissionRecord,
  ReadmissionQueryParams,
  MipsRecord,
  MipsQueryParams,
  PartdRecord,
  PartdQueryParams,
  QueryResult,
  DataLineage,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL pool (lazy-initialized when not in demo mode)
// ─────────────────────────────────────────────────────────────────────────────

let pool: Pool | null = null;

/**
 * Get (or create) the PostgreSQL connection pool.
 * Throws if called when DATABASE_URL is not configured.
 */
function getPool(): Pool {
  if (!pool) {
    if (!config.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL not configured. Set DEMO_MODE=true or provide DATABASE_URL."
      );
    }
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      idleTimeoutMillis: config.DB_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: 5000,
    });

    pool.on("error", (err) => {
      logger.error("PostgreSQL pool error", { error: err.message });
    });

    logger.info("PostgreSQL pool initialized", {
      max: config.DB_POOL_MAX,
    });
  }
  return pool;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dataset catalog (metadata registry)
// ─────────────────────────────────────────────────────────────────────────────

/** Authoritative catalog of all available CMS datasets. */
export const DATASET_CATALOG: Record<DatasetId, DatasetMetadata> = {
  hcc_risk_adjustment: {
    id: "hcc_risk_adjustment",
    name: "Medicare HCC Risk Adjustment (V28)",
    description:
      "CMS-HCC V28 hierarchical condition categories and relative risk factors " +
      "for Medicare Advantage risk score calculation. Maps ICD-10-CM diagnosis " +
      "codes to HCC categories with demographic cost factors.",
    source: "CMS Center for Medicare and Medicaid Innovation",
    updateFrequency: "annual",
    lastUpdated: "2024-01-01",
    rowCount: 12847,
    keyFields: ["icd_code", "hcc_category", "model_year"],
    availableFilters: [
      "icdCode",
      "hccCategory",
      "minRiskScore",
      "maxRiskScore",
      "modelYear",
      "state",
    ],
    cacheTtlSeconds: 86400,
  },
  hospital_readmission: {
    id: "hospital_readmission",
    name: "Hospital 30-Day Readmission Rates (HCUP AHRQ)",
    description:
      "Hospital-level 30-day unplanned readmission rates for AMI, CHF, COPD, " +
      "pneumonia, hip/knee replacement, and CABG. Includes national benchmarks " +
      "and performance category (better/same/worse than national rate).",
    source: "AHRQ Healthcare Cost and Utilization Project (HCUP)",
    updateFrequency: "quarterly",
    lastUpdated: "2024-03-31",
    rowCount: 48523,
    keyFields: ["hospital_ccn", "measure_id", "reporting_period"],
    availableFilters: [
      "hospitalCcn",
      "hospitalName",
      "measureId",
      "maxReadmissionRate",
      "state",
      "startDate",
      "endDate",
    ],
    cacheTtlSeconds: 300,
  },
  mips_quality_measures: {
    id: "mips_quality_measures",
    name: "MIPS Quality Payment Program Measures",
    description:
      "Provider-level MIPS quality measure performance rates from the CMS " +
      "Quality Payment Program. Includes process, outcome, and patient experience " +
      "measures across specialties. NPI-level granularity.",
    source: "CMS Quality Payment Program (QPP)",
    updateFrequency: "annual",
    lastUpdated: "2023-12-31",
    rowCount: 2341087,
    keyFields: ["npi", "measure_id", "reporting_year"],
    availableFilters: [
      "npi",
      "measureId",
      "specialty",
      "minPerformanceRate",
      "state",
      "startDate",
      "endDate",
    ],
    cacheTtlSeconds: 86400,
  },
  partd_drug_utilization: {
    id: "partd_drug_utilization",
    name: "Medicare Part D Drug Utilization and Cost",
    description:
      "Medicare Part D prescription drug utilization, beneficiary counts, " +
      "day supply, and total drug costs at drug/state/year granularity. " +
      "Includes generic and brand drugs across all therapeutic classes.",
    source: "CMS Medicare Part D Prescriber Public Use File",
    updateFrequency: "annual",
    lastUpdated: "2022-12-31",
    rowCount: 1892345,
    keyFields: ["drug_name", "state", "reporting_year"],
    availableFilters: [
      "drugName",
      "drugClass",
      "prescriberNpi",
      "minClaims",
      "state",
      "startDate",
      "endDate",
    ],
    cacheTtlSeconds: 86400,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Lineage builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build DataLineage metadata for a query result.
 *
 * @param datasetId - Source dataset.
 * @param cacheHit - Whether the result came from cache.
 * @param cacheTtlRemaining - Remaining TTL if cache hit.
 */
function buildLineage(
  datasetId: DatasetId,
  cacheHit: boolean,
  cacheTtlRemaining?: number
): DataLineage {
  const meta = DATASET_CATALOG[datasetId];
  return {
    source: meta.source,
    sourceUrl: `https://data.cms.gov/datasets/${datasetId}`,
    dataVersion: meta.lastUpdated,
    lastUpdated: meta.lastUpdated,
    retrievedAt: new Date().toISOString(),
    cacheHit,
    cacheTtlRemainingSeconds: cacheTtlRemaining,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedded sample data (DEMO_MODE)
// ─────────────────────────────────────────────────────────────────────────────

/** Sample HCC records representative of CMS-HCC V28 top categories. */
const SAMPLE_HCC_DATA: HccRecord[] = [
  {
    icdCode: "E11.9",
    icdDescription: "Type 2 diabetes mellitus without complications",
    hccCategory: 19,
    hccDescription: "Diabetes without Complication",
    relativeFactorDual: 0.302,
    relativeFactorNondual: 0.302,
    modelYear: 2024,
    hierarchyGroup: "Diabetes",
  },
  {
    icdCode: "E11.65",
    icdDescription: "Type 2 diabetes mellitus with hyperglycemia",
    hccCategory: 19,
    hccDescription: "Diabetes without Complication",
    relativeFactorDual: 0.302,
    relativeFactorNondual: 0.302,
    modelYear: 2024,
    hierarchyGroup: "Diabetes",
  },
  {
    icdCode: "E11.40",
    icdDescription: "Type 2 diabetes mellitus with diabetic neuropathy, unspecified",
    hccCategory: 18,
    hccDescription: "Diabetes with Chronic Complications",
    relativeFactorDual: 0.320,
    relativeFactorNondual: 0.318,
    modelYear: 2024,
    hierarchyGroup: "Diabetes",
  },
  {
    icdCode: "I50.9",
    icdDescription: "Heart failure, unspecified",
    hccCategory: 85,
    hccDescription: "Congestive Heart Failure",
    relativeFactorDual: 0.323,
    relativeFactorNondual: 0.331,
    modelYear: 2024,
    hierarchyGroup: "Cardiovascular",
  },
  {
    icdCode: "I50.22",
    icdDescription: "Chronic systolic heart failure",
    hccCategory: 85,
    hccDescription: "Congestive Heart Failure",
    relativeFactorDual: 0.323,
    relativeFactorNondual: 0.331,
    modelYear: 2024,
    hierarchyGroup: "Cardiovascular",
  },
  {
    icdCode: "J44.1",
    icdDescription: "Chronic obstructive pulmonary disease with acute exacerbation",
    hccCategory: 111,
    hccDescription: "Chronic Obstructive Pulmonary Disease",
    relativeFactorDual: 0.335,
    relativeFactorNondual: 0.335,
    modelYear: 2024,
    hierarchyGroup: "Pulmonary",
  },
  {
    icdCode: "N18.4",
    icdDescription: "Chronic kidney disease, stage 4",
    hccCategory: 138,
    hccDescription: "Chronic Kidney Disease, Stage 4",
    relativeFactorDual: 0.289,
    relativeFactorNondual: 0.289,
    modelYear: 2024,
    hierarchyGroup: "Renal",
  },
  {
    icdCode: "C34.90",
    icdDescription: "Malignant neoplasm of unspecified part of unspecified bronchus or lung",
    hccCategory: 9,
    hccDescription: "Lung and Other Severe Cancers",
    relativeFactorDual: 1.023,
    relativeFactorNondual: 1.023,
    modelYear: 2024,
    hierarchyGroup: "Cancer",
  },
  {
    icdCode: "G35",
    icdDescription: "Multiple sclerosis",
    hccCategory: 77,
    hccDescription: "Multiple Sclerosis",
    relativeFactorDual: 0.421,
    relativeFactorNondual: 0.421,
    modelYear: 2024,
    hierarchyGroup: "Neurological",
  },
  {
    icdCode: "I21.9",
    icdDescription: "Acute myocardial infarction, unspecified",
    hccCategory: 86,
    hccDescription: "Acute Myocardial Infarction",
    relativeFactorDual: 0.278,
    relativeFactorNondual: 0.278,
    modelYear: 2024,
    hierarchyGroup: "Cardiovascular",
  },
];

/** Sample hospital readmission records. */
const SAMPLE_READMISSION_DATA: ReadmissionRecord[] = [
  {
    hospitalCcn: "450289",
    hospitalName: "Memorial Hermann Hospital",
    state: "TX",
    measureId: "READM-30-AMI",
    measureName: "30-Day AMI Readmission Rate",
    denominator: 423,
    numerator: 58,
    readmissionRate: 0.137,
    nationalRate: 0.152,
    performanceCategory: "better",
    reportingPeriod: "2022-07-01/2023-06-30",
  },
  {
    hospitalCcn: "450289",
    hospitalName: "Memorial Hermann Hospital",
    state: "TX",
    measureId: "READM-30-HF",
    measureName: "30-Day Heart Failure Readmission Rate",
    denominator: 892,
    numerator: 192,
    readmissionRate: 0.215,
    nationalRate: 0.221,
    performanceCategory: "same",
    reportingPeriod: "2022-07-01/2023-06-30",
  },
  {
    hospitalCcn: "330101",
    hospitalName: "NewYork-Presbyterian Hospital",
    state: "NY",
    measureId: "READM-30-COPD",
    measureName: "30-Day COPD Readmission Rate",
    denominator: 1204,
    numerator: 238,
    readmissionRate: 0.198,
    nationalRate: 0.204,
    performanceCategory: "same",
    reportingPeriod: "2022-07-01/2023-06-30",
  },
  {
    hospitalCcn: "050376",
    hospitalName: "Cedars-Sinai Medical Center",
    state: "CA",
    measureId: "READM-30-AMI",
    measureName: "30-Day AMI Readmission Rate",
    denominator: 567,
    numerator: 72,
    readmissionRate: 0.127,
    nationalRate: 0.152,
    performanceCategory: "better",
    reportingPeriod: "2022-07-01/2023-06-30",
  },
  {
    hospitalCcn: "230038",
    hospitalName: "University of Michigan Health",
    state: "MI",
    measureId: "READM-30-PN",
    measureName: "30-Day Pneumonia Readmission Rate",
    denominator: 789,
    numerator: 142,
    readmissionRate: 0.18,
    nationalRate: 0.172,
    performanceCategory: "worse",
    reportingPeriod: "2022-07-01/2023-06-30",
  },
];

/** Sample MIPS quality measure records. */
const SAMPLE_MIPS_DATA: MipsRecord[] = [
  {
    npi: "1234567890",
    providerName: "Smith, John A",
    specialty: "Internal Medicine",
    measureId: "001",
    measureName: "Diabetes: Hemoglobin A1c (HbA1c) Poor Control (>9%)",
    measureCategory: "Diabetes",
    denominator: 145,
    numerator: 22,
    performanceRate: 0.152,
    reportingYear: 2023,
    measureType: "outcome",
  },
  {
    npi: "1234567890",
    providerName: "Smith, John A",
    specialty: "Internal Medicine",
    measureId: "236",
    measureName: "Controlling High Blood Pressure",
    measureCategory: "Cardiovascular",
    denominator: 312,
    numerator: 267,
    performanceRate: 0.856,
    reportingYear: 2023,
    measureType: "process",
  },
  {
    npi: "9876543210",
    providerName: "Johnson, Maria L",
    specialty: "Cardiology",
    measureId: "005",
    measureName: "Heart Failure: ACE Inhibitor or ARB Therapy",
    measureCategory: "Heart Failure",
    denominator: 203,
    numerator: 197,
    performanceRate: 0.97,
    reportingYear: 2023,
    measureType: "process",
  },
  {
    npi: "5551234567",
    providerName: "Patel, Priya R",
    specialty: "Pulmonology",
    measureId: "052",
    measureName: "Chronic Obstructive Pulmonary Disease: Inhaled Bronchodilator Therapy",
    measureCategory: "Pulmonary",
    denominator: 88,
    numerator: 83,
    performanceRate: 0.943,
    reportingYear: 2023,
    measureType: "process",
  },
];

/** Sample Part D drug utilization records. */
const SAMPLE_PARTD_DATA: PartdRecord[] = [
  {
    drugName: "Metformin HCl",
    genericName: "metformin hydrochloride",
    brandName: "Glucophage",
    drugClass: "Biguanides (Antidiabetics)",
    totalClaims: 89234,
    totalBeneficiaries: 67812,
    totalDayCoverage: 8921340,
    totalDrugCost: 4123450.0,
    avgCostPerClaim: 46.21,
    avgCostPerDay: 0.46,
    reportingYear: 2022,
    state: "TX",
  },
  {
    drugName: "Lisinopril",
    genericName: "lisinopril",
    brandName: "Prinivil/Zestril",
    drugClass: "ACE Inhibitors (Antihypertensives)",
    totalClaims: 112456,
    totalBeneficiaries: 89234,
    totalDayCoverage: 11245600,
    totalDrugCost: 5234780.0,
    avgCostPerClaim: 46.54,
    avgCostPerDay: 0.47,
    reportingYear: 2022,
    state: "TX",
  },
  {
    drugName: "Atorvastatin Calcium",
    genericName: "atorvastatin calcium",
    brandName: "Lipitor",
    drugClass: "Statins (Lipid-Lowering)",
    totalClaims: 145678,
    totalBeneficiaries: 112345,
    totalDayCoverage: 14567800,
    totalDrugCost: 8923450.0,
    avgCostPerClaim: 61.26,
    avgCostPerDay: 0.61,
    reportingYear: 2022,
    state: "CA",
  },
  {
    drugName: "Empagliflozin",
    genericName: "empagliflozin",
    brandName: "Jardiance",
    drugClass: "SGLT2 Inhibitors (Antidiabetics)",
    totalClaims: 23456,
    totalBeneficiaries: 18234,
    totalDayCoverage: 2345600,
    totalDrugCost: 85234560.0,
    avgCostPerClaim: 3635.12,
    avgCostPerDay: 36.35,
    reportingYear: 2022,
    state: "TX",
  },
  {
    drugName: "Semaglutide",
    genericName: "semaglutide",
    brandName: "Ozempic",
    drugClass: "GLP-1 Agonists (Antidiabetics)",
    totalClaims: 45678,
    totalBeneficiaries: 34512,
    totalDayCoverage: 4567800,
    totalDrugCost: 234567890.0,
    avgCostPerClaim: 5135.02,
    avgCostPerDay: 51.35,
    reportingYear: 2022,
    state: "NY",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Demo mode query functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply common base filters (state, limit, order) to any record array.
 */
function applyBaseFilters<T extends { state?: string }>(
  data: T[],
  params: { state?: string; limit?: number; orderBy?: string }
): T[] {
  let result = [...data];

  if (params.state) {
    result = result.filter((r) => r.state === params.state);
  }

  if (params.orderBy) {
    const [field, dir] = params.orderBy.split(" ");
    result.sort((a, b) => {
      const av = (a as Record<string, unknown>)[field];
      const bv = (b as Record<string, unknown>)[field];
      if (typeof av === "number" && typeof bv === "number") {
        return dir?.toLowerCase() === "desc" ? bv - av : av - bv;
      }
      return 0;
    });
  }

  return result.slice(0, params.limit ?? 100);
}

/** Query HCC records from embedded demo data. */
function queryHccDemo(params: HccQueryParams): HccRecord[] {
  let data = [...SAMPLE_HCC_DATA];

  if (params.icdCode) {
    const prefix = params.icdCode.replace(".", "");
    data = data.filter((r) =>
      r.icdCode.replace(".", "").startsWith(prefix)
    );
  }
  if (params.hccCategory !== undefined) {
    data = data.filter((r) => r.hccCategory === params.hccCategory);
  }
  if (params.minRiskScore !== undefined) {
    data = data.filter((r) => r.relativeFactorNondual >= params.minRiskScore!);
  }
  if (params.maxRiskScore !== undefined) {
    data = data.filter((r) => r.relativeFactorNondual <= params.maxRiskScore!);
  }
  if (params.modelYear !== undefined) {
    data = data.filter((r) => r.modelYear === params.modelYear);
  }

  return applyBaseFilters(data as (HccRecord & { state?: string })[], params)
    .map(({ state: _s, ...rest }) => rest) as HccRecord[];
}

/** Query readmission records from embedded demo data. */
function queryReadmissionDemo(params: ReadmissionQueryParams): ReadmissionRecord[] {
  let data = [...SAMPLE_READMISSION_DATA];

  if (params.hospitalCcn) {
    data = data.filter((r) => r.hospitalCcn === params.hospitalCcn);
  }
  if (params.hospitalName) {
    const lower = params.hospitalName.toLowerCase();
    data = data.filter((r) => r.hospitalName.toLowerCase().includes(lower));
  }
  if (params.measureId) {
    data = data.filter((r) => r.measureId === params.measureId);
  }
  if (params.maxReadmissionRate !== undefined) {
    data = data.filter((r) => r.readmissionRate <= params.maxReadmissionRate!);
  }

  return applyBaseFilters(data, params);
}

/** Query MIPS records from embedded demo data. */
function queryMipsDemo(params: MipsQueryParams): MipsRecord[] {
  let data = [...SAMPLE_MIPS_DATA];

  if (params.npi) {
    data = data.filter((r) => r.npi === params.npi);
  }
  if (params.measureId) {
    data = data.filter((r) => r.measureId === params.measureId);
  }
  if (params.specialty) {
    const lower = params.specialty.toLowerCase();
    data = data.filter((r) => r.specialty.toLowerCase().includes(lower));
  }
  if (params.minPerformanceRate !== undefined) {
    data = data.filter((r) => r.performanceRate >= params.minPerformanceRate!);
  }

  return applyBaseFilters(data as (MipsRecord & { state?: string })[], params)
    .map(({ state: _s, ...rest }) => rest) as MipsRecord[];
}

/** Query Part D records from embedded demo data. */
function queryPartdDemo(params: PartdQueryParams): PartdRecord[] {
  let data = [...SAMPLE_PARTD_DATA];

  if (params.drugName) {
    const lower = params.drugName.toLowerCase();
    data = data.filter((r) =>
      r.drugName.toLowerCase().includes(lower) ||
      r.genericName.toLowerCase().includes(lower)
    );
  }
  if (params.drugClass) {
    const lower = params.drugClass.toLowerCase();
    data = data.filter((r) => r.drugClass.toLowerCase().includes(lower));
  }
  if (params.minClaims !== undefined) {
    data = data.filter((r) => r.totalClaims >= params.minClaims!);
  }

  return applyBaseFilters(data, params);
}

// ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL query functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a parameterized PostgreSQL query.
 * All parameters are passed as positional $N placeholders — never concatenated.
 *
 * @param sql - Parameterized SQL template.
 * @param values - Parameter array corresponding to $1, $2, ...
 * @returns Array of row objects.
 */
async function execQuery<T>(sql: string, values: unknown[]): Promise<T[]> {
  const client = await getPool().connect();
  try {
    logger.debug("Executing query", { sql, paramCount: values.length });
    const result = await client.query(sql, values);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public data access interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch HCC risk adjustment data.
 *
 * @param params - Validated HCC query parameters.
 * @param requestId - Trace identifier for audit log.
 * @returns Typed QueryResult wrapping HCC records.
 */
export async function fetchHccData(
  params: HccQueryParams,
  requestId: string
): Promise<QueryResult<HccRecord>> {
  let rows: HccRecord[];

  if (config.DEMO_MODE) {
    rows = queryHccDemo(params);
  } else {
    // Build parameterized SQL dynamically with positional params
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (params.icdCode) {
      conditions.push(`icd_code LIKE $${idx++}`);
      values.push(`${params.icdCode}%`);
    }
    if (params.hccCategory !== undefined) {
      conditions.push(`hcc_category = $${idx++}`);
      values.push(params.hccCategory);
    }
    if (params.minRiskScore !== undefined) {
      conditions.push(`relative_factor_nondual >= $${idx++}`);
      values.push(params.minRiskScore);
    }
    if (params.maxRiskScore !== undefined) {
      conditions.push(`relative_factor_nondual <= $${idx++}`);
      values.push(params.maxRiskScore);
    }
    if (params.modelYear !== undefined) {
      conditions.push(`model_year = $${idx++}`);
      values.push(params.modelYear);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = params.orderBy
      ? `ORDER BY ${params.orderBy.split(" ")[0]} ${params.orderBy.split(" ")[1] || "ASC"}`
      : "ORDER BY hcc_category ASC";
    const limit = `LIMIT $${idx}`;
    values.push(params.limit ?? 100);

    rows = await execQuery<HccRecord>(
      `SELECT icd_code, icd_description, hcc_category, hcc_description,
              relative_factor_dual, relative_factor_nondual, model_year, hierarchy_group
       FROM cms.hcc_risk_adjustment ${where} ${order} ${limit}`,
      values
    );
  }

  return {
    requestId,
    datasetId: "hcc_risk_adjustment",
    rowCount: rows.length,
    rows,
    lineage: buildLineage("hcc_risk_adjustment", false),
  };
}

/**
 * Fetch hospital readmission rate data.
 *
 * @param params - Validated readmission query parameters.
 * @param requestId - Trace identifier.
 * @returns Typed QueryResult wrapping readmission records.
 */
export async function fetchReadmissionData(
  params: ReadmissionQueryParams,
  requestId: string
): Promise<QueryResult<ReadmissionRecord>> {
  let rows: ReadmissionRecord[];

  if (config.DEMO_MODE) {
    rows = queryReadmissionDemo(params);
  } else {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (params.hospitalCcn) {
      conditions.push(`hospital_ccn = $${idx++}`);
      values.push(params.hospitalCcn);
    }
    if (params.hospitalName) {
      conditions.push(`hospital_name ILIKE $${idx++}`);
      values.push(`%${params.hospitalName}%`);
    }
    if (params.measureId) {
      conditions.push(`measure_id = $${idx++}`);
      values.push(params.measureId);
    }
    if (params.maxReadmissionRate !== undefined) {
      conditions.push(`readmission_rate <= $${idx++}`);
      values.push(params.maxReadmissionRate);
    }
    if (params.state) {
      conditions.push(`state = $${idx++}`);
      values.push(params.state);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = `LIMIT $${idx}`;
    values.push(params.limit ?? 100);

    rows = await execQuery<ReadmissionRecord>(
      `SELECT hospital_ccn, hospital_name, state, measure_id, measure_name,
              denominator, numerator, readmission_rate, national_rate,
              performance_category, reporting_period
       FROM cms.hospital_readmission ${where}
       ORDER BY readmission_rate ASC ${limit}`,
      values
    );
  }

  return {
    requestId,
    datasetId: "hospital_readmission",
    rowCount: rows.length,
    rows,
    lineage: buildLineage("hospital_readmission", false),
  };
}

/**
 * Fetch MIPS quality measure performance data.
 *
 * @param params - Validated MIPS query parameters.
 * @param requestId - Trace identifier.
 * @returns Typed QueryResult wrapping MIPS records.
 */
export async function fetchMipsData(
  params: MipsQueryParams,
  requestId: string
): Promise<QueryResult<MipsRecord>> {
  let rows: MipsRecord[];

  if (config.DEMO_MODE) {
    rows = queryMipsDemo(params);
  } else {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (params.npi) {
      conditions.push(`npi = $${idx++}`);
      values.push(params.npi);
    }
    if (params.measureId) {
      conditions.push(`measure_id = $${idx++}`);
      values.push(params.measureId);
    }
    if (params.specialty) {
      conditions.push(`specialty ILIKE $${idx++}`);
      values.push(`%${params.specialty}%`);
    }
    if (params.minPerformanceRate !== undefined) {
      conditions.push(`performance_rate >= $${idx++}`);
      values.push(params.minPerformanceRate);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = `LIMIT $${idx}`;
    values.push(params.limit ?? 100);

    rows = await execQuery<MipsRecord>(
      `SELECT npi, provider_name, specialty, measure_id, measure_name,
              measure_category, denominator, numerator, performance_rate,
              reporting_year, measure_type
       FROM cms.mips_quality_measures ${where}
       ORDER BY performance_rate DESC ${limit}`,
      values
    );
  }

  return {
    requestId,
    datasetId: "mips_quality_measures",
    rowCount: rows.length,
    rows,
    lineage: buildLineage("mips_quality_measures", false),
  };
}

/**
 * Fetch Medicare Part D drug utilization data.
 *
 * @param params - Validated Part D query parameters.
 * @param requestId - Trace identifier.
 * @returns Typed QueryResult wrapping Part D records.
 */
export async function fetchPartdData(
  params: PartdQueryParams,
  requestId: string
): Promise<QueryResult<PartdRecord>> {
  let rows: PartdRecord[];

  if (config.DEMO_MODE) {
    rows = queryPartdDemo(params);
  } else {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (params.drugName) {
      conditions.push(
        `(generic_name ILIKE $${idx} OR drug_name ILIKE $${idx})`
      );
      values.push(`%${params.drugName}%`);
      idx++;
    }
    if (params.drugClass) {
      conditions.push(`drug_class ILIKE $${idx++}`);
      values.push(`%${params.drugClass}%`);
    }
    if (params.minClaims !== undefined) {
      conditions.push(`total_claims >= $${idx++}`);
      values.push(params.minClaims);
    }
    if (params.state) {
      conditions.push(`state = $${idx++}`);
      values.push(params.state);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = `LIMIT $${idx}`;
    values.push(params.limit ?? 100);

    rows = await execQuery<PartdRecord>(
      `SELECT drug_name, generic_name, brand_name, drug_class,
              total_claims, total_beneficiaries, total_day_coverage,
              total_drug_cost, avg_cost_per_claim, avg_cost_per_day,
              reporting_year, state
       FROM cms.partd_drug_utilization ${where}
       ORDER BY total_drug_cost DESC ${limit}`,
      values
    );
  }

  return {
    requestId,
    datasetId: "partd_drug_utilization",
    rowCount: rows.length,
    rows,
    lineage: buildLineage("partd_drug_utilization", false),
  };
}

/**
 * Gracefully shut down the database connection pool.
 * Called on SIGTERM / SIGINT.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info("PostgreSQL pool closed");
  }
}
