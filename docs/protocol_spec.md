# CMS MCP Server — Protocol Specification

**Version:** 1.0.0
**Protocol:** Model Context Protocol (MCP) v1.0
**Transport:** stdio
**Author:** Andrew Lee | github.com/SaeMind

---

## 1. Overview

This document specifies the MCP tool interface exposed by the CMS MCP Server.
The server enables natural-language access to four CMS healthcare datasets through
Claude without requiring SQL expertise or direct API knowledge.

**Architecture:**

```
[Claude] ←── MCP Protocol ──→ [CMS MCP Server]
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
              [In-Memory        [PostgreSQL]   [Validation +
               Cache]            (optional)     Rate Limit]
```

---

## 2. Transport

The server uses **stdio transport** as specified by the MCP standard. Communication
occurs over standard input/output, making it compatible with Claude Desktop's MCP
configuration and the Anthropic API tool use interface.

**Claude Desktop config** (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cms-healthcare-data": {
      "command": "node",
      "args": ["/path/to/cms-mcp-server/dist/server.js"],
      "env": {
        "DEMO_MODE": "true",
        "MCP_API_KEY": "your_key_here"
      }
    }
  }
}
```

---

## 3. Authentication

Authentication is optional (disabled by default in demo mode).

When `MCP_API_KEY` is set, all tool calls must include `api_key` in their arguments:

```json
{
  "name": "list_datasets",
  "arguments": {
    "api_key": "your_key_here"
  }
}
```

Authentication uses constant-time string comparison to prevent timing attacks.

---

## 4. Rate Limiting

Default limit: **100 requests/minute per API key** (configurable via `RATE_LIMIT_REQUESTS_PER_MIN`).

Exceeded requests receive an error response:

```json
{
  "error": "Rate limit exceeded. Retry after 42s. Limit: 100 requests/min.",
  "requestId": "uuid-here"
}
```

---

## 5. Tool Definitions

### 5.1 `list_datasets`

Returns the complete catalog of available CMS datasets.

**Input:** `{ api_key?: string }`

**Output:**
```json
{
  "datasets": [
    {
      "id": "hcc_risk_adjustment",
      "name": "Medicare HCC Risk Adjustment (V28)",
      "source": "CMS Center for Medicare and Medicaid Innovation",
      "updateFrequency": "annual",
      "lastUpdated": "2024-01-01",
      "rowCount": 12847,
      "keyFields": ["icd_code", "hcc_category", "model_year"],
      "availableFilters": ["icdCode", "hccCategory", ...]
    }
  ],
  "count": 4,
  "serverMode": "demo"
}
```

### 5.2 `get_schema`

Returns field-level schema for a specific dataset.

**Input:**
```json
{
  "dataset_id": "hcc_risk_adjustment",
  "api_key": "optional"
}
```

**Output:** Schema object with fields array containing `name`, `type`, `description`, `example`.

### 5.3 `get_data`

Primary data retrieval tool. Supports all CMS datasets with type-specific filters.

**Input:**
```json
{
  "dataset_id": "hospital_readmission",
  "filters": {
    "state": "TX",
    "measure_id": "READM-30-AMI",
    "max_readmission_rate": 0.15,
    "limit": 25,
    "order_by": "readmission_rate asc"
  },
  "api_key": "optional"
}
```

**Output:**
```json
{
  "requestId": "uuid",
  "datasetId": "hospital_readmission",
  "rowCount": 12,
  "rows": [...],
  "lineage": {
    "source": "AHRQ Healthcare Cost and Utilization Project (HCUP)",
    "sourceUrl": "https://data.cms.gov/datasets/hospital_readmission",
    "dataVersion": "2024-03-31",
    "lastUpdated": "2024-03-31",
    "retrievedAt": "2025-06-09T12:00:00Z",
    "cacheHit": false
  }
}
```

### 5.4 `run_query`

Executes a pre-approved named query template.

**Input:**
```json
{
  "template_id": "partd_top_drugs_by_cost",
  "parameters": { "limit": 10 },
  "api_key": "optional"
}
```

**Approved templates:**

| Template ID | Dataset | Description |
|---|---|---|
| `hcc_by_icd_code` | hcc_risk_adjustment | ICD-10 to HCC mapping lookup |
| `hcc_by_category` | hcc_risk_adjustment | All codes in an HCC category |
| `hcc_risk_score_distribution` | hcc_risk_adjustment | Distribution of risk factors |
| `readmission_by_hospital` | hospital_readmission | Per-hospital readmission summary |
| `readmission_by_state` | hospital_readmission | State-level aggregate |
| `readmission_national_benchmark` | hospital_readmission | All hospitals vs national rate |
| `mips_performance_by_provider` | mips_quality_measures | Provider performance summary |
| `mips_performance_by_measure` | mips_quality_measures | Measure-level performance |
| `mips_specialty_summary` | mips_quality_measures | Specialty-level aggregate |
| `partd_cost_by_drug` | partd_drug_utilization | Drug-level cost breakdown |
| `partd_utilization_trends` | partd_drug_utilization | Utilization by drug class |
| `partd_top_drugs_by_cost` | partd_drug_utilization | Highest-cost drugs |

### 5.5 `cache_status`

Returns cache statistics.

**Output:**
```json
{
  "cache": {
    "keys": 14,
    "hits": 89,
    "misses": 23,
    "hitRatio": 79.46,
    "vsize": 48234,
    "ksize": 1024
  },
  "ttlPolicy": {
    "referenceDatasets": ["hcc_risk_adjustment", "mips_quality_measures"],
    "referenceTtlSeconds": 86400,
    "transactionalTtlSeconds": 300
  }
}
```

### 5.6 `get_sample_queries`

Returns example queries for a dataset.

**Input:** `{ "dataset_id": "partd_drug_utilization" }`

**Output:** Array of sample query objects with `description`, `tool`, and `arguments`.

---

## 6. Filter Parameters

### Common (all datasets)

| Parameter | Type | Description |
|---|---|---|
| `state` | string | 2-letter FIPS state code (e.g. TX, CA) |
| `start_date` | string | ISO date or YYYY-QN (e.g. 2023-Q1) |
| `end_date` | string | ISO date or YYYY-QN |
| `limit` | integer | Max rows (1–1000, default 100) |
| `order_by` | string | `field_name asc\|desc` |

### HCC-specific

| Parameter | Type | Format |
|---|---|---|
| `icd_code` | string | ICD-10-CM prefix/exact (e.g. E11 or E11.9) |
| `hcc_category` | integer | HCC category number |
| `min_risk_score` | number | Minimum relative factor |
| `max_risk_score` | number | Maximum relative factor |
| `model_year` | integer | CMS-HCC model year (2019–2030) |

### Readmission-specific

| Parameter | Type | Format |
|---|---|---|
| `hospital_ccn` | string | 6-digit CCN |
| `hospital_name` | string | Partial match |
| `measure_id` | string | READM-NN-XXXXX |
| `max_readmission_rate` | number | 0.0–1.0 |

### MIPS-specific

| Parameter | Type | Format |
|---|---|---|
| `npi` | string | 10-digit NPI |
| `measure_id` | string | 3-digit MIPS measure ID |
| `specialty` | string | Partial match |
| `min_performance_rate` | number | 0.0–1.0 |

### Part D-specific

| Parameter | Type | Format |
|---|---|---|
| `drug_name` | string | Partial match (generic or brand) |
| `drug_class` | string | Partial match |
| `prescriber_npi` | string | 10-digit NPI |
| `min_claims` | integer | Minimum claim count |

---

## 7. Security

### SQL Injection Prevention

All query parameters are validated via Zod schemas before use. String parameters
are sanitized (SQL meta-characters stripped). Queries use only pre-approved
templates with positional `$N` parameters — no SQL concatenation.

### Authentication

API key validated using `crypto.timingSafeEqual()` to prevent timing attacks.

### Input Validation

- ICD-10 codes validated against `^[A-Z][0-9A-Z]{1,2}(\.[0-9A-Z]{1,4})?$`
- NPIs validated against `^\d{10}$`
- State codes validated against `^[A-Z]{2}$`
- CCNs validated against `^\d{6}$`
- String parameters capped at 128–256 characters

### Audit Logging

Every tool call writes to `./outputs/audit.log` (NDJSON format):
```json
{
  "requestId": "uuid",
  "timestamp": "ISO-8601",
  "tool": "get_data",
  "datasetId": "hcc_risk_adjustment",
  "params": {...},
  "durationMs": 12,
  "rowsReturned": 10,
  "cacheHit": false
}
```

---

## 8. Caching

| Dataset | TTL | Rationale |
|---|---|---|
| `hcc_risk_adjustment` | 24h | Static within a model year |
| `mips_quality_measures` | 24h | Annual publication cycle |
| `hospital_readmission` | 5min | Quarterly updates |
| `partd_drug_utilization` | 24h | Annual publication cycle |

Cache keys are SHA-256 hashes of `(dataset_id + canonical_params_json)`.
Identical queries with the same parameters always share a cache entry.

---

## 9. Data Sources

| Dataset | Source | URL |
|---|---|---|
| HCC Risk Adjustment | CMS-HCC V28 | https://www.cms.gov/medicare/hcc |
| Hospital Readmission | HCUP AHRQ | https://www.qualityindicators.ahrq.gov |
| MIPS Quality Measures | QPP CMS | https://qpp.cms.gov |
| Part D Utilization | CMS Part D | https://data.cms.gov |

All data is public, aggregate (no PHI), and read-only.
