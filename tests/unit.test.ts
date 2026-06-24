/**
 * @file unit.test.ts
 * @description Unit tests for query validators, cache layer, and tool handlers.
 *
 * Coverage targets:
 *  - Parameter validation: valid inputs, boundary conditions, invalid inputs
 *  - SQL injection prevention: malicious string patterns
 *  - Cache key determinism: same params → same key
 *  - Dataset ID validation: valid and invalid identifiers
 *  - Template whitelist: approved and rejected template IDs
 */

// Set demo mode before importing modules that read config
process.env.DEMO_MODE = "true";
process.env.LOG_LEVEL = "error"; // suppress log noise in tests

import {
  validateQueryParams,
  validateDatasetId,
  assertApprovedTemplate,
  APPROVED_QUERY_TEMPLATES,
} from "../src/validators";

import {
  makeCacheKey,
  getCache,
  setCache,
  flushCache,
  getCacheStats,
} from "../src/cache";

import type { DatasetId, QueryResult } from "../src/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal valid QueryResult for cache tests. */
function mockResult(datasetId: DatasetId): QueryResult {
  return {
    requestId: "test-req-1",
    datasetId,
    rowCount: 2,
    rows: [{ id: 1 }, { id: 2 }],
    lineage: {
      source: "Test",
      sourceUrl: "https://example.com",
      dataVersion: "2024-01-01",
      lastUpdated: "2024-01-01",
      retrievedAt: new Date().toISOString(),
      cacheHit: false,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// validateDatasetId
// ─────────────────────────────────────────────────────────────────────────────

describe("validateDatasetId", () => {
  it("accepts all valid dataset IDs", () => {
    const valid: DatasetId[] = [
      "hcc_risk_adjustment",
      "hospital_readmission",
      "mips_quality_measures",
      "partd_drug_utilization",
    ];
    valid.forEach((id) => {
      expect(() => validateDatasetId(id)).not.toThrow();
      expect(validateDatasetId(id)).toBe(id);
    });
  });

  it("rejects unknown dataset IDs", () => {
    expect(() => validateDatasetId("unknown_dataset")).toThrow(
      "Invalid dataset_id"
    );
  });

  it("rejects non-string inputs", () => {
    expect(() => validateDatasetId(42)).toThrow("Invalid dataset_id");
    expect(() => validateDatasetId(null)).toThrow("Invalid dataset_id");
    expect(() => validateDatasetId(undefined)).toThrow("Invalid dataset_id");
  });

  it("rejects empty string", () => {
    expect(() => validateDatasetId("")).toThrow("Invalid dataset_id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertApprovedTemplate
// ─────────────────────────────────────────────────────────────────────────────

describe("assertApprovedTemplate", () => {
  it("accepts all approved template IDs", () => {
    APPROVED_QUERY_TEMPLATES.forEach((id) => {
      expect(() => assertApprovedTemplate(id)).not.toThrow();
    });
  });

  it("rejects non-approved template IDs", () => {
    expect(() => assertApprovedTemplate("drop_table_users")).toThrow(
      "not approved"
    );
    expect(() => assertApprovedTemplate("SELECT * FROM cms.hcc")).toThrow(
      "not approved"
    );
    expect(() => assertApprovedTemplate("")).toThrow("not approved");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HCC parameter validation
// ─────────────────────────────────────────────────────────────────────────────

describe("validateQueryParams — hcc_risk_adjustment", () => {
  it("accepts valid minimal params (empty)", () => {
    const result = validateQueryParams("hcc_risk_adjustment", {});
    expect(result.success).toBe(true);
  });

  it("accepts valid ICD-10 code", () => {
    const result = validateQueryParams("hcc_risk_adjustment", {
      icdCode: "E11.9",
    });
    expect(result.success).toBe(true);
  });

  it("normalizes ICD codes to uppercase", () => {
    const result = validateQueryParams("hcc_risk_adjustment", {
      icdCode: "e11.9",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { icdCode: string }).icdCode).toBe("E11.9");
    }
  });

  it("rejects invalid ICD-10 format", () => {
    const result = validateQueryParams("hcc_risk_adjustment", {
      icdCode: "invalid_code_!!",
    });
    expect(result.success).toBe(false);
  });

  it("rejects limit exceeding 1000", () => {
    const result = validateQueryParams("hcc_risk_adjustment", { limit: 9999 });
    expect(result.success).toBe(false);
  });

  it("rejects limit below 1", () => {
    const result = validateQueryParams("hcc_risk_adjustment", { limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects minRiskScore > maxRiskScore", () => {
    const result = validateQueryParams("hcc_risk_adjustment", {
      minRiskScore: 0.8,
      maxRiskScore: 0.2,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.some((e) => e.includes("minRiskScore"))).toBe(true);
    }
  });

  it("accepts valid risk score range", () => {
    const result = validateQueryParams("hcc_risk_adjustment", {
      minRiskScore: 0.2,
      maxRiskScore: 0.8,
    });
    expect(result.success).toBe(true);
  });

  it("rejects modelYear outside valid range", () => {
    const result = validateQueryParams("hcc_risk_adjustment", {
      modelYear: 2000,
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Readmission parameter validation
// ─────────────────────────────────────────────────────────────────────────────

describe("validateQueryParams — hospital_readmission", () => {
  it("accepts valid CCN", () => {
    const result = validateQueryParams("hospital_readmission", {
      hospitalCcn: "450289",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-6-digit CCN", () => {
    const result = validateQueryParams("hospital_readmission", {
      hospitalCcn: "12345",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid measure ID format", () => {
    const result = validateQueryParams("hospital_readmission", {
      measureId: "READM-30-AMI",
    });
    expect(result.success).toBe(true);
  });

  it("rejects SQL injection attempt in hospitalName", () => {
    const result = validateQueryParams("hospital_readmission", {
      hospitalName: "'; DROP TABLE cms.hospital_readmission; --",
    });
    // Sanitization strips dangerous chars; should still succeed but with cleaned value
    expect(result.success).toBe(true);
    if (result.success) {
      const name = (result.data as { hospitalName?: string }).hospitalName ?? "";
      expect(name).not.toContain("'");
      expect(name).not.toContain(";");
      expect(name).not.toContain("--");
    }
  });

  it("rejects maxReadmissionRate > 1.0", () => {
    const result = validateQueryParams("hospital_readmission", {
      maxReadmissionRate: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid state code", () => {
    const result = validateQueryParams("hospital_readmission", {
      state: "Texas",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid 2-letter state code", () => {
    const result = validateQueryParams("hospital_readmission", { state: "TX" });
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MIPS parameter validation
// ─────────────────────────────────────────────────────────────────────────────

describe("validateQueryParams — mips_quality_measures", () => {
  it("accepts valid 10-digit NPI", () => {
    const result = validateQueryParams("mips_quality_measures", {
      npi: "1234567890",
    });
    expect(result.success).toBe(true);
  });

  it("rejects NPI with wrong digit count", () => {
    const result = validateQueryParams("mips_quality_measures", {
      npi: "12345",
    });
    expect(result.success).toBe(false);
  });

  it("rejects NPI with non-digits", () => {
    const result = validateQueryParams("mips_quality_measures", {
      npi: "12345ABCDE",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid MIPS measure ID", () => {
    const result = validateQueryParams("mips_quality_measures", {
      measureId: "001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects performance rate > 1.0", () => {
    const result = validateQueryParams("mips_quality_measures", {
      minPerformanceRate: 1.1,
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part D parameter validation
// ─────────────────────────────────────────────────────────────────────────────

describe("validateQueryParams — partd_drug_utilization", () => {
  it("accepts valid drug name", () => {
    const result = validateQueryParams("partd_drug_utilization", {
      drugName: "Metformin",
    });
    expect(result.success).toBe(true);
  });

  it("sanitizes SQL meta-characters from drugName", () => {
    const result = validateQueryParams("partd_drug_utilization", {
      drugName: "Metformin' OR '1'='1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const name = (result.data as { drugName?: string }).drugName ?? "";
      expect(name).not.toContain("'");
    }
  });

  it("accepts valid minClaims", () => {
    const result = validateQueryParams("partd_drug_utilization", {
      minClaims: 1000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative minClaims", () => {
    const result = validateQueryParams("partd_drug_utilization", {
      minClaims: -1,
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache layer
// ─────────────────────────────────────────────────────────────────────────────

describe("Cache layer", () => {
  beforeEach(() => {
    flushCache();
  });

  it("generates deterministic keys (param order-independent)", () => {
    const key1 = makeCacheKey("hcc_risk_adjustment", { limit: 10, state: "TX" });
    const key2 = makeCacheKey("hcc_risk_adjustment", { state: "TX", limit: 10 });
    expect(key1).toBe(key2);
  });

  it("generates different keys for different datasets", () => {
    const key1 = makeCacheKey("hcc_risk_adjustment", { limit: 10 });
    const key2 = makeCacheKey("hospital_readmission", { limit: 10 });
    expect(key1).not.toBe(key2);
  });

  it("generates different keys for different params", () => {
    const key1 = makeCacheKey("hcc_risk_adjustment", { limit: 10 });
    const key2 = makeCacheKey("hcc_risk_adjustment", { limit: 20 });
    expect(key1).not.toBe(key2);
  });

  it("returns undefined on cache miss", () => {
    const result = getCache("nonexistent:key");
    expect(result).toBeUndefined();
  });

  it("stores and retrieves a result", () => {
    const key = makeCacheKey("hcc_risk_adjustment", { limit: 5 });
    const result = mockResult("hcc_risk_adjustment");
    setCache(key, result, "hcc_risk_adjustment");

    const retrieved = getCache(key);
    expect(retrieved).toBeDefined();
    expect(retrieved?.rowCount).toBe(2);
    expect(retrieved?.datasetId).toBe("hcc_risk_adjustment");
  });

  it("returns stats after cache operations", () => {
    const key = makeCacheKey("hcc_risk_adjustment", { limit: 5 });
    setCache(key, mockResult("hcc_risk_adjustment"), "hcc_risk_adjustment");

    // Trigger a hit and a miss
    getCache(key);          // hit
    getCache("no-such-key"); // miss

    const stats = getCacheStats();
    expect(stats.keys).toBeGreaterThanOrEqual(1);
    expect(stats.hits).toBeGreaterThanOrEqual(1);
    expect(stats.misses).toBeGreaterThanOrEqual(1);
  });

  it("flushes all keys", () => {
    const key = makeCacheKey("hcc_risk_adjustment", { limit: 5 });
    setCache(key, mockResult("hcc_risk_adjustment"), "hcc_risk_adjustment");
    flushCache();

    const retrieved = getCache(key);
    expect(retrieved).toBeUndefined();

    const stats = getCacheStats();
    expect(stats.keys).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SQL injection surface area — adversarial inputs
// ─────────────────────────────────────────────────────────────────────────────

describe("SQL injection prevention", () => {
  const injectionStrings = [
    "'; DROP TABLE cms.hcc_risk_adjustment; --",
    "1' OR '1'='1",
    "1; SELECT * FROM pg_user; --",
    "UNION SELECT * FROM information_schema.tables--",
    "'; EXEC xp_cmdshell('dir'); --",
    "%27%20OR%20%271%27%3D%271",
  ];

  it.each(injectionStrings)(
    "sanitizes injection attempt in hospitalName: %s",
    (injection) => {
      const result = validateQueryParams("hospital_readmission", {
        hospitalName: injection,
      });
      if (result.success) {
        const name = (result.data as { hospitalName?: string }).hospitalName ?? "";
        // Dangerous characters must be removed
        expect(name).not.toMatch(/['";\-\-]/);
      }
      // Either rejected or sanitized — both are acceptable
    }
  );

  it.each(injectionStrings)(
    "sanitizes injection in drugName: %s",
    (injection) => {
      const result = validateQueryParams("partd_drug_utilization", {
        drugName: injection,
      });
      if (result.success) {
        const name = (result.data as { drugName?: string }).drugName ?? "";
        expect(name).not.toContain("'");
        expect(name).not.toContain(";");
      }
    }
  );

  it("rejects NPI with injection attempt", () => {
    const result = validateQueryParams("mips_quality_measures", {
      npi: "123'; DROP",
    });
    expect(result.success).toBe(false);
  });

  it("rejects ICD code with SQL keywords", () => {
    const result = validateQueryParams("hcc_risk_adjustment", {
      icdCode: "SELECT",
    });
    // SELECT doesn't match ICD-10 pattern (requires 3-char alphanumeric start)
    expect(result.success).toBe(false);
  });
});
