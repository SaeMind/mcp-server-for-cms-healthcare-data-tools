/**
 * @file integration.test.ts
 * @description Integration tests for MCP tool handlers in demo mode.
 *
 * Tests the full tool call lifecycle:
 *  - list_datasets → catalog completeness
 *  - get_schema → schema field presence
 *  - get_data → filter correctness, result shape, lineage metadata
 *  - run_query → template routing, result integrity
 *  - cache_status → stats shape
 *  - get_sample_queries → sample completeness
 *
 * All tests run against DEMO_MODE=true (no database or external APIs required).
 * Rate limiting is exercised but set to high limits to avoid test interference.
 */

process.env.DEMO_MODE = "true";
process.env.LOG_LEVEL = "error";
process.env.RATE_LIMIT_REQUESTS_PER_MIN = "500"; // high limit for test parallelism
process.env.MCP_API_KEY = ""; // disable auth for tests

import {
  handleListDatasets,
  handleGetSchema,
  handleGetData,
  handleRunQuery,
  handleCacheStatus,
  handleGetSampleQueries,
} from "../src/tools";
import { flushCache } from "../src/cache";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const TEST_RATE_KEY = "test-integration";

/** Parse the JSON text from a tool result content block. */
function parseResult(result: { content: { type: string; text: string }[] }): unknown {
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  return JSON.parse(result.content[0].text);
}

/** Check that a tool result is NOT an error. */
function assertSuccess(result: { isError?: boolean; content: { text: string }[] }): void {
  if (result.isError) {
    const parsed = JSON.parse(result.content[0].text);
    throw new Error(`Tool returned error: ${parsed.error}`);
  }
}

beforeEach(() => {
  flushCache();
});

// ─────────────────────────────────────────────────────────────────────────────
// list_datasets
// ─────────────────────────────────────────────────────────────────────────────

describe("handleListDatasets", () => {
  it("returns all 4 CMS datasets", async () => {
    const result = await handleListDatasets({}, TEST_RATE_KEY);
    assertSuccess(result);
    const data = parseResult(result) as { datasets: unknown[]; count: number; serverMode: string };

    expect(data.count).toBe(4);
    expect(data.datasets).toHaveLength(4);
    expect(data.serverMode).toBe("demo");
  });

  it("includes required metadata fields on each dataset", async () => {
    const result = await handleListDatasets({}, TEST_RATE_KEY);
    const data = parseResult(result) as { datasets: Record<string, unknown>[] };

    data.datasets.forEach((ds) => {
      expect(ds).toHaveProperty("id");
      expect(ds).toHaveProperty("name");
      expect(ds).toHaveProperty("source");
      expect(ds).toHaveProperty("updateFrequency");
      expect(ds).toHaveProperty("rowCount");
      expect(ds).toHaveProperty("keyFields");
      expect(ds).toHaveProperty("availableFilters");
    });
  });

  it("includes all expected dataset IDs", async () => {
    const result = await handleListDatasets({}, TEST_RATE_KEY);
    const data = parseResult(result) as { datasets: { id: string }[] };
    const ids = data.datasets.map((d) => d.id);

    expect(ids).toContain("hcc_risk_adjustment");
    expect(ids).toContain("hospital_readmission");
    expect(ids).toContain("mips_quality_measures");
    expect(ids).toContain("partd_drug_utilization");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get_schema
// ─────────────────────────────────────────────────────────────────────────────

describe("handleGetSchema", () => {
  it("returns schema for hcc_risk_adjustment with required fields", async () => {
    const result = await handleGetSchema(
      { dataset_id: "hcc_risk_adjustment" },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { schema: { fields: { name: string }[] } };

    const fieldNames = data.schema.fields.map((f) => f.name);
    expect(fieldNames).toContain("icdCode");
    expect(fieldNames).toContain("hccCategory");
    expect(fieldNames).toContain("relativeFactorNondual");
  });

  it("returns schema for partd_drug_utilization", async () => {
    const result = await handleGetSchema(
      { dataset_id: "partd_drug_utilization" },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { schema: { fields: { name: string }[] } };

    const fieldNames = data.schema.fields.map((f) => f.name);
    expect(fieldNames).toContain("drugName");
    expect(fieldNames).toContain("totalDrugCost");
    expect(fieldNames).toContain("avgCostPerClaim");
  });

  it("returns error for invalid dataset ID", async () => {
    const result = await handleGetSchema(
      { dataset_id: "nonexistent" },
      TEST_RATE_KEY
    );
    expect(result.isError).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get_data — HCC
// ─────────────────────────────────────────────────────────────────────────────

describe("handleGetData — hcc_risk_adjustment", () => {
  it("returns HCC records with required fields", async () => {
    const result = await handleGetData(
      { dataset_id: "hcc_risk_adjustment" },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as {
      rows: Record<string, unknown>[];
      rowCount: number;
      lineage: Record<string, unknown>;
    };

    expect(data.rowCount).toBeGreaterThan(0);
    expect(data.rows.length).toBe(data.rowCount);
    expect(data.lineage).toBeDefined();
    expect(data.lineage.source).toBeTruthy();
    expect(data.lineage.cacheHit).toBe(false);
  });

  it("filters by ICD code prefix", async () => {
    const result = await handleGetData(
      { dataset_id: "hcc_risk_adjustment", filters: { icd_code: "E11" } },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { rows: { icdCode: string }[] };

    expect(data.rows.length).toBeGreaterThan(0);
    data.rows.forEach((r) => {
      expect(r.icdCode).toMatch(/^E11/);
    });
  });

  it("filters by HCC category", async () => {
    const result = await handleGetData(
      { dataset_id: "hcc_risk_adjustment", filters: { hcc_category: 85 } },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { rows: { hccCategory: number }[] };

    data.rows.forEach((r) => {
      expect(r.hccCategory).toBe(85);
    });
  });

  it("returns empty rows for non-matching filter", async () => {
    const result = await handleGetData(
      {
        dataset_id: "hcc_risk_adjustment",
        filters: { hcc_category: 499 },
      },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { rowCount: number };
    expect(data.rowCount).toBe(0);
  });

  it("respects limit parameter", async () => {
    const result = await handleGetData(
      { dataset_id: "hcc_risk_adjustment", filters: { limit: 3 } },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { rows: unknown[] };
    expect(data.rows.length).toBeLessThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get_data — hospital_readmission
// ─────────────────────────────────────────────────────────────────────────────

describe("handleGetData — hospital_readmission", () => {
  it("returns readmission records with benchmark data", async () => {
    const result = await handleGetData(
      { dataset_id: "hospital_readmission" },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as {
      rows: {
        readmissionRate: number;
        nationalRate: number;
        performanceCategory: string;
      }[];
    };

    expect(data.rows.length).toBeGreaterThan(0);
    data.rows.forEach((r) => {
      expect(r.readmissionRate).toBeGreaterThanOrEqual(0);
      expect(r.nationalRate).toBeGreaterThan(0);
      expect(["better", "same", "worse", "not_available"]).toContain(
        r.performanceCategory
      );
    });
  });

  it("filters by state", async () => {
    const result = await handleGetData(
      { dataset_id: "hospital_readmission", filters: { state: "TX" } },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { rows: { state: string }[] };

    data.rows.forEach((r) => {
      expect(r.state).toBe("TX");
    });
  });

  it("filters by hospital name (partial match)", async () => {
    const result = await handleGetData(
      {
        dataset_id: "hospital_readmission",
        filters: { hospital_name: "Memorial" },
      },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { rows: { hospitalName: string }[]; rowCount: number };

    expect(data.rowCount).toBeGreaterThan(0);
    data.rows.forEach((r) => {
      expect(r.hospitalName.toLowerCase()).toContain("memorial");
    });
  });

  it("filters by maxReadmissionRate", async () => {
    const result = await handleGetData(
      {
        dataset_id: "hospital_readmission",
        filters: { max_readmission_rate: 0.15 },
      },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { rows: { readmissionRate: number }[] };

    data.rows.forEach((r) => {
      expect(r.readmissionRate).toBeLessThanOrEqual(0.15);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get_data — MIPS
// ─────────────────────────────────────────────────────────────────────────────

describe("handleGetData — mips_quality_measures", () => {
  it("returns MIPS records with performance rates", async () => {
    const result = await handleGetData(
      { dataset_id: "mips_quality_measures" },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as {
      rows: { performanceRate: number; measureType: string }[];
    };

    expect(data.rows.length).toBeGreaterThan(0);
    data.rows.forEach((r) => {
      expect(r.performanceRate).toBeGreaterThanOrEqual(0);
      expect(r.performanceRate).toBeLessThanOrEqual(1);
    });
  });

  it("filters by NPI", async () => {
    const result = await handleGetData(
      {
        dataset_id: "mips_quality_measures",
        filters: { npi: "1234567890" },
      },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { rows: { npi: string }[] };

    data.rows.forEach((r) => {
      expect(r.npi).toBe("1234567890");
    });
  });

  it("filters by minPerformanceRate", async () => {
    const result = await handleGetData(
      {
        dataset_id: "mips_quality_measures",
        filters: { min_performance_rate: 0.9 },
      },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { rows: { performanceRate: number }[] };

    data.rows.forEach((r) => {
      expect(r.performanceRate).toBeGreaterThanOrEqual(0.9);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get_data — Part D
// ─────────────────────────────────────────────────────────────────────────────

describe("handleGetData — partd_drug_utilization", () => {
  it("returns Part D records with cost fields", async () => {
    const result = await handleGetData(
      { dataset_id: "partd_drug_utilization" },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as {
      rows: { totalDrugCost: number; avgCostPerClaim: number }[];
    };

    expect(data.rows.length).toBeGreaterThan(0);
    data.rows.forEach((r) => {
      expect(r.totalDrugCost).toBeGreaterThan(0);
      expect(r.avgCostPerClaim).toBeGreaterThan(0);
    });
  });

  it("filters by drug name (partial match)", async () => {
    const result = await handleGetData(
      { dataset_id: "partd_drug_utilization", filters: { drug_name: "Metformin" } },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as {
      rows: { drugName: string; genericName: string }[];
      rowCount: number;
    };

    expect(data.rowCount).toBeGreaterThan(0);
  });

  it("filters by minClaims", async () => {
    const result = await handleGetData(
      { dataset_id: "partd_drug_utilization", filters: { min_claims: 50000 } },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { rows: { totalClaims: number }[] };

    data.rows.forEach((r) => {
      expect(r.totalClaims).toBeGreaterThanOrEqual(50000);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// run_query
// ─────────────────────────────────────────────────────────────────────────────

describe("handleRunQuery", () => {
  it("executes hcc_risk_score_distribution template", async () => {
    const result = await handleRunQuery(
      { template_id: "hcc_risk_score_distribution" },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { rowCount: number };
    expect(data.rowCount).toBeGreaterThan(0);
  });

  it("executes readmission_by_hospital template", async () => {
    const result = await handleRunQuery(
      { template_id: "readmission_by_hospital" },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { rows: unknown[] };
    expect(data.rows.length).toBeGreaterThan(0);
  });

  it("executes partd_top_drugs_by_cost with limit override", async () => {
    const result = await handleRunQuery(
      { template_id: "partd_top_drugs_by_cost", parameters: { limit: 3 } },
      TEST_RATE_KEY
    );
    assertSuccess(result);
    const data = parseResult(result) as { rows: unknown[] };
    expect(data.rows.length).toBeLessThanOrEqual(3);
  });

  it("rejects non-approved template IDs", async () => {
    const result = await handleRunQuery(
      { template_id: "SELECT * FROM users" },
      TEST_RATE_KEY
    );
    expect(result.isError).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cache_status
// ─────────────────────────────────────────────────────────────────────────────

describe("handleCacheStatus", () => {
  it("returns cache stats with expected shape", async () => {
    // Warm cache with a query
    await handleGetData({ dataset_id: "hcc_risk_adjustment" }, TEST_RATE_KEY);

    const result = await handleCacheStatus({}, TEST_RATE_KEY);
    assertSuccess(result);
    const data = parseResult(result) as {
      cache: { keys: number; hitRatio: number; hits: number; misses: number };
      ttlPolicy: Record<string, unknown>;
    };

    expect(data.cache.keys).toBeGreaterThanOrEqual(0);
    expect(typeof data.cache.hitRatio).toBe("number");
    expect(data.ttlPolicy).toBeDefined();
    expect(data.ttlPolicy.referenceTtlSeconds).toBe(86400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get_sample_queries
// ─────────────────────────────────────────────────────────────────────────────

describe("handleGetSampleQueries", () => {
  it("returns samples for all 4 datasets", async () => {
    const datasets = [
      "hcc_risk_adjustment",
      "hospital_readmission",
      "mips_quality_measures",
      "partd_drug_utilization",
    ];

    for (const dsId of datasets) {
      const result = await handleGetSampleQueries(
        { dataset_id: dsId },
        TEST_RATE_KEY
      );
      assertSuccess(result);
      const data = parseResult(result) as {
        sampleQueries: unknown[];
        datasetId: string;
      };

      expect(data.datasetId).toBe(dsId);
      expect(data.sampleQueries.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Caching behavior — integration
// ─────────────────────────────────────────────────────────────────────────────

describe("Caching integration", () => {
  it("second identical request returns cache hit", async () => {
    flushCache();

    const first = await handleGetData(
      { dataset_id: "hcc_risk_adjustment", filters: { limit: 5 } },
      TEST_RATE_KEY
    );
    const firstData = parseResult(first) as { lineage: { cacheHit: boolean } };
    expect(firstData.lineage.cacheHit).toBe(false);

    const second = await handleGetData(
      { dataset_id: "hcc_risk_adjustment", filters: { limit: 5 } },
      TEST_RATE_KEY
    );
    const secondData = parseResult(second) as { lineage: { cacheHit: boolean } };
    expect(secondData.lineage.cacheHit).toBe(true);
  });

  it("different filter params produce different cache entries", async () => {
    flushCache();

    await handleGetData(
      { dataset_id: "hcc_risk_adjustment", filters: { limit: 5 } },
      TEST_RATE_KEY
    );
    await handleGetData(
      { dataset_id: "hcc_risk_adjustment", filters: { limit: 10 } },
      TEST_RATE_KEY
    );

    const stats = await handleCacheStatus({}, TEST_RATE_KEY);
    const data = parseResult(stats) as { cache: { keys: number } };
    expect(data.cache.keys).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

describe("Error handling", () => {
  it("returns structured error for invalid dataset", async () => {
    const result = await handleGetData(
      { dataset_id: "not_a_real_dataset" },
      TEST_RATE_KEY
    );
    expect(result.isError).toBe(true);
    const data = parseResult(result) as { error: string };
    expect(data.error).toContain("Invalid dataset_id");
  });

  it("returns structured error for invalid params", async () => {
    const result = await handleGetData(
      {
        dataset_id: "hcc_risk_adjustment",
        filters: { limit: 99999 },
      },
      TEST_RATE_KEY
    );
    expect(result.isError).toBe(true);
    const data = parseResult(result) as { error: string };
    expect(data.error).toContain("validation");
  });

  it("never exposes stack traces in error responses", async () => {
    const result = await handleGetData(
      { dataset_id: "invalid" },
      TEST_RATE_KEY
    );
    const raw = result.content[0].text;
    expect(raw).not.toContain("at Object.");
    expect(raw).not.toContain("node_modules");
  });
});
