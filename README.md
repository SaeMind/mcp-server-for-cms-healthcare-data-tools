# CMS Healthcare Data MCP Server

> **Production-grade Model Context Protocol (MCP) server exposing four CMS public datasets as callable tools in Claude conversations — enabling natural-language RWE analytics without SQL expertise.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.0.4-purple)](https://github.com/anthropics/anthropic-sdk)
[![Node](https://img.shields.io/badge/Node-20+-green)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

---

## Overview

Real-world evidence analysts spend a significant portion of project time on data access mechanics: locating CMS datasets, writing parameterized SQL, handling pagination, and normalizing schemas. This server solves that infrastructure problem at the protocol layer.

The server implements the [Model Context Protocol](https://modelcontextprotocol.io/) specification and runs as a local stdio process that Claude Desktop registers as a tool provider. Once registered, analysts can query HCC risk scores, hospital readmission rates, MIPS quality measures, and Part D drug utilization using plain English — the server handles validation, caching, and safe query execution.

**Key capabilities:**

| Capability | Implementation |
|---|---|
| Protocol compliance | MCP SDK v1.0.4, `StdioServerTransport` |
| Datasets exposed | 4 CMS public datasets |
| Tools available | 6 callable tools |
| Query templates | 12 pre-approved, injection-safe templates |
| Caching | TTL-based (NodeCache): 24h reference, 5min transactional |
| Security | API key auth, rate limiting (100 req/min), Zod validation |
| Audit logging | NDJSON audit trail to `outputs/audit.log` |
| Demo mode | Embedded sample data — no database required to run |

---

## Why MCP for CMS Data?

Traditional CMS data access requires analysts to maintain database credentials, write parameterized SQL, manage connection pools, and handle API pagination. For clinical researchers whose primary skill is domain expertise — not software engineering — this friction reduces productivity and introduces error risk.

MCP solves this by standardizing the interface between language models and external data systems. The server exposes a typed, versioned, audited contract. Claude calls tools; the server handles everything beneath that.

**Comparison to alternatives:**

| Approach | SQL Expertise Required | Audit Trail | Protocol Standard | Claude Native |
|---|---|---|---|---|
| Direct database query | Yes | No | No | No |
| REST API wrapper | Partial | Optional | No | No |
| **MCP Server (this project)** | **No** | **Yes** | **Yes (MCP)** | **Yes** |
| Custom Claude plugin | No | Optional | Proprietary | Partial |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Desktop                           │
│              (MCP client, initiates tool calls)                 │
└─────────────────────────┬───────────────────────────────────────┘
                          │ stdio (MCP protocol)
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                     server.ts (MCP Server)                      │
│  - StdioServerTransport                                         │
│  - ListToolsRequestSchema handler                               │
│  - CallToolRequestSchema handler                                │
│  - HTTP health endpoint (:3000/health)                          │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   tools.ts (Request Pipeline)                   │
│                                                                 │
│  [1] API Key Auth → [2] Rate Limiter → [3] Zod Validation      │
│  [4] Cache Lookup → [5] Data Fetch  → [6] Cache Store          │
│  [7] Audit Write  → [8] JSON Response                          │
└────────────┬──────────────────────┬────────────────────────────┘
             │                      │
             ▼                      ▼
┌────────────────────┐   ┌──────────────────────────────────────┐
│    validators.ts   │   │           datasources.ts             │
│                    │   │                                      │
│  - Zod schemas     │   │  DEMO_MODE=true  → sample data       │
│  - SQL sanitizer   │   │  DEMO_MODE=false → PostgreSQL pool   │
│  - Template        │   │                                      │
│    whitelist       │   │  fetchHccData()                      │
│    (12 templates)  │   │  fetchReadmissionData()              │
│                    │   │  fetchMipsData()                     │
└────────────────────┘   │  fetchPartdData()                    │
                         └──────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                         cache.ts                                │
│  NodeCache TTL tiers:                                           │
│  - Reference data (HCC, MIPS): 24h                             │
│  - Transactional (readmission, Part D): 5min                   │
│  - SHA-256 deterministic cache keys                            │
└─────────────────────────────────────────────────────────────────┘
```

**Directory structure:**

```
cms-mcp-server/
├── src/
│   ├── server.ts         # MCP server core, transport, health endpoint
│   ├── tools.ts          # Tool definitions and request handlers
│   ├── datasources.ts    # CMS data connectors (demo + PostgreSQL)
│   ├── validators.ts     # Zod schemas, sanitizer, template whitelist
│   ├── cache.ts          # TTL cache with deterministic key generation
│   ├── config.ts         # Zod-validated environment configuration
│   ├── logger.ts         # Winston app + audit + query loggers
│   └── types.ts          # Shared TypeScript interfaces
├── tests/
│   ├── unit.test.ts      # Validator, cache, injection-safety tests
│   └── integration.test.ts  # Full tool lifecycle in DEMO_MODE
├── schema/
│   ├── cms_data_schema.json  # JSON Schema Draft-07 for all record types
│   └── init.sql              # PostgreSQL schema for production mode
├── docs/
│   └── protocol_spec.md      # Full MCP protocol specification
├── outputs/              # Runtime: audit.log written here
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── jest.config.cjs
├── package.json
└── tsconfig.json
```

---

## Exposed Datasets

| Dataset ID | Source | Update Frequency | Cache TTL | Key Fields |
|---|---|---|---|---|
| `hcc_risk_adjustment` | CMS-HCC V28 Model | Annual | 24h | `icd10Code`, `hccCategory`, `riskScore`, `modelYear` |
| `hospital_readmission` | HCUP AHRQ | Quarterly | 5min | `ccn`, `measureId`, `readmissionRate`, `state` |
| `mips_quality_measures` | CMS QPP | Annual | 24h | `npi`, `measureId`, `performanceScore`, `specialty` |
| `partd_drug_utilization` | CMS Part D PUF | Annual | 24h | `drugName`, `genericName`, `totalCost`, `claimCount` |

**Data lineage metadata** is returned on every response:

```json
{
  "dataLineage": {
    "source": "CMS-HCC V28 Risk Adjustment Model",
    "sourceUrl": "https://www.cms.gov/medicare/payment/medicare-advantage/risk-adjustment",
    "lastUpdated": "2024-01-01T00:00:00Z",
    "lagDays": 365,
    "disclaimer": "CMS data has 3-6 month lag..."
  }
}
```

---

## Tools Reference

### `list_datasets`
Returns the catalog of all available CMS datasets with metadata.

**Parameters:** None

**Returns:** Array of dataset descriptors including ID, name, description, source URL, last-updated timestamp, and row count.

---

### `get_schema`
Returns the field schema for a specific dataset.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `datasetId` | `string` | Yes | One of the four dataset IDs above |

---

### `get_data`
Retrieves filtered records from a dataset.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `datasetId` | `string` | Yes | Target dataset |
| `filters` | `object` | No | Dataset-specific filter fields (see below) |
| `limit` | `number` | No | Max rows returned (1–1000, default 100) |

**HCC filters:** `icd10Code` (regex: `/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/`), `hccCategory` (integer), `modelYear` (2020–2030), `riskScoreMin/Max` (0.0–5.0)

**Readmission filters:** `ccn` (6-digit), `state` (2-letter), `measureId`, `readmissionRateMin/Max` (0.0–1.0)

**MIPS filters:** `npi` (10-digit), `specialty` (string), `measureId`, `performanceScoreMin/Max` (0–100)

**Part D filters:** `drugName` (string), `genericName` (string), `year` (2015–2030), `minTotalCost` (number)

---

### `run_query`
Executes a named, pre-approved query template with parameters.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `templateId` | `string` | Yes | One of 12 approved templates |
| `params` | `object` | No | Template-specific parameters |

**Approved templates:**

| Template ID | Dataset | Description |
|---|---|---|
| `hcc_by_icd_code` | HCC | Retrieve HCC mappings for a specific ICD-10 code |
| `hcc_by_category` | HCC | All diagnoses in a given HCC category |
| `hcc_risk_score_distribution` | HCC | Risk score distribution across model years |
| `readmission_by_hospital` | Readmission | Readmission rates for a specific hospital (CCN) |
| `readmission_by_state` | Readmission | State-level readmission rate summary |
| `readmission_national_benchmark` | Readmission | National average by measure |
| `mips_performance_by_provider` | MIPS | MIPS scores for a specific NPI |
| `mips_performance_by_measure` | MIPS | Performance distribution for a quality measure |
| `mips_specialty_summary` | MIPS | Average MIPS score by specialty |
| `partd_cost_by_drug` | Part D | Cost trends for a specific drug |
| `partd_utilization_trends` | Part D | Year-over-year claim volume trends |
| `partd_top_drugs_by_cost` | Part D | Top N drugs by total cost |

---

### `cache_status`
Returns current cache statistics.

**Returns:** Hit rate, miss rate, key count, memory usage, TTL configuration.

---

### `get_sample_queries`
Returns ready-to-use example queries for a dataset.

**Parameters:**

| Parameter | Type | Required |
|---|---|---|
| `datasetId` | `string` | Yes |

---

## How to Run

### Prerequisites

- Node.js 20+
- npm 10+
- (Optional, for production mode) PostgreSQL 16+

### Installation

```bash
git clone https://github.com/SaeMind/cms-mcp-server.git
cd cms-mcp-server
npm install
```

### Environment configuration

```bash
cp .env.example .env
```

Key variables:

```env
# Set to true to run with embedded sample data (no database required)
DEMO_MODE=true

# Required only when DEMO_MODE=false
DATABASE_URL=postgresql://cms_user:password@localhost:5432/cms_data

# Optional: enable API key authentication
API_KEY=your-key-here

# Optional: override rate limit (default: 100 req/min)
RATE_LIMIT_PER_MINUTE=100

# Optional: override HTTP health port (default: 3000)
PORT=3000
```

### Build and start (demo mode)

```bash
npm run build
npm start
```

The server starts on stdio and exposes a health endpoint at `http://localhost:3000/health`.

### Start without build (development)

```bash
npm run dev
```

### Docker (PostgreSQL + server)

```bash
mkdir -p outputs
docker-compose up --build
```

The compose stack starts PostgreSQL 16 on port 5432 and the MCP server. The database schema is initialized from `schema/init.sql`.

---

## Configure Claude Desktop

Add the following block to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cms-healthcare-data": {
      "command": "node",
      "args": ["/absolute/path/to/cms-mcp-server/dist/server.js"],
      "env": {
        "DEMO_MODE": "true"
      }
    }
  }
}
```

Restart Claude Desktop. The server tools appear under the tool picker in any new conversation.

---

## Example Queries

Once registered, invoke tools directly in Claude:

**List available datasets:**
```
Call list_datasets
```

**HCC risk score for E11.9 (Type 2 Diabetes):**
```
Call get_data with datasetId=hcc_risk_adjustment, filters={icd10Code: "E11.9"}
```

**Hospital readmission rate by state:**
```
Call run_query with templateId=readmission_by_state, params={state: "TX"}
```

**MIPS performance for a specific provider:**
```
Call run_query with templateId=mips_performance_by_provider, params={npi: "1234567890"}
```

**Top 10 Part D drugs by total cost:**
```
Call run_query with templateId=partd_top_drugs_by_cost, params={limit: 10}
```

**Drug utilization trend for metformin:**
```
Call run_query with templateId=partd_cost_by_drug, params={drugName: "metformin"}
```

---

## Safety and Validation

Security is implemented in layers. Each tool call passes through the full pipeline before any data is accessed:

```
[1] API Key Authentication  →  Constant-time comparison (crypto.timingSafeEqual)
[2] Rate Limiting           →  RateLimiterMemory, 100 req/min per key
[3] Input Validation        →  Zod schemas per dataset; type coercion disabled
[4] String Sanitization     →  Strip SQL metacharacters: ' " ; -- /* */ xp_ EXEC
[5] Template Whitelist      →  run_query only executes from 12 approved templates
[6] Parameterized SQL       →  All PostgreSQL queries use $N positional params
[7] Audit Logging           →  Every call written to outputs/audit.log (NDJSON)
```

**No raw SQL is accepted from callers under any circumstances.** The `run_query` tool maps template IDs to pre-written, parameterized query objects. Parameters are validated and sanitized before substitution. The approved template set is a `ReadonlySet<string>` — it cannot be extended at runtime.

**Audit log entry format (NDJSON):**

```json
{
  "timestamp": "2024-06-01T14:23:11.042Z",
  "level": "audit",
  "tool": "run_query",
  "templateId": "readmission_by_state",
  "params": {"state": "TX"},
  "cacheHit": false,
  "rowsReturned": 47,
  "durationMs": 12,
  "apiKeyHash": "sha256:a1b2c3..."
}
```

---

## Testing

```bash
# Full test suite
npm test

# Unit tests only (validators, cache, injection safety)
npm run test:unit

# Integration tests only (full tool lifecycle in DEMO_MODE)
npm run test:integration

# Type checking without emit
npm run typecheck
```

**Unit test coverage:**

| Area | Tests |
|---|---|
| `validateDatasetId` | Valid IDs, invalid strings, non-string inputs |
| `assertApprovedTemplate` | All 12 valid templates, rejection of arbitrary strings |
| HCC parameter validation | ICD-10 regex, risk score bounds, limit bounds, model year range |
| Readmission validation | CCN format, rate bounds, SQL injection in free-text fields |
| MIPS validation | NPI regex, score bounds |
| Part D validation | Year range, cost floor |
| Cache | Key determinism (parameter order independence), store/retrieve, TTL expiry, flush, stats |
| SQL injection adversarial suite | 6 injection patterns across all string filter fields |

**Integration test coverage:**

| Scenario | Assertion |
|---|---|
| `list_datasets` returns 4 entries | Dataset IDs match expected set |
| `get_schema` returns field metadata | Schema fields present per dataset |
| `get_data` HCC with ICD filter | Result rows match filter |
| `get_data` readmission with state filter | State field matches filter value |
| Cache hit on duplicate request | Second identical call returns `cacheHit: true` |
| Error response shape | No stack traces; `error` field present |
| `run_query` template routing | All 12 templates resolve without error |
| `get_sample_queries` | Returns non-empty array per dataset |

---

## Technologies Used

| Technology | Version | Role |
|---|---|---|
| TypeScript | 5.3 | Language (strict mode) |
| `@modelcontextprotocol/sdk` | 1.0.4 | MCP server and transport |
| `zod` | 3.22 | Runtime schema validation |
| `node-cache` | 5.1 | TTL-based in-process caching |
| `rate-limiter-flexible` | 5.0 | In-memory rate limiting |
| `pg` | 8.11 | PostgreSQL client (production mode) |
| `winston` | 3.11 | Structured logging and audit trail |
| `dotenv` | 16.4 | Environment configuration |
| Jest + ts-jest | 29.7 | Unit and integration testing |
| Docker + PostgreSQL 16 | — | Optional production backend |

---

## Data Sources

| Dataset | Source | URL |
|---|---|---|
| CMS-HCC V28 Risk Adjustment | CMS Medicare Advantage | https://www.cms.gov/medicare/payment/medicare-advantage/risk-adjustment |
| Hospital Readmission Rates | HCUP AHRQ | https://hcupnet.ahrq.gov/ |
| MIPS Quality Measures | CMS QPP | https://qpp.cms.gov/mips/quality-measures |
| Part D Drug Utilization | CMS Part D PUF | https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers |

All datasets are CMS public data. No PHI is accessed or stored. All outputs are aggregate or de-identified per CMS data use agreements.

---

## Extending the Server

To add a new dataset:

1. Add the dataset ID to the `DatasetId` union type in `src/types.ts`
2. Define the filter interface and Zod schema in `src/validators.ts`
3. Add a fetch function in `src/datasources.ts`
4. Add the tool handler branch in `src/tools.ts`
5. Add the dataset entry to `DATASET_CATALOG`
6. Add corresponding unit and integration tests
7. Update `schema/cms_data_schema.json` with the new record type

---

## Related Work

This server implements the same pattern used by enterprise RWE platforms (Flatiron, IQVIA, Komodo Health) to expose claims data through typed interfaces — but applies it at the protocol layer rather than the application layer, enabling LLM-native access without a purpose-built frontend.

**Relevant literature:**

- Bodenreider O. (2004). The Unified Medical Language System (UMLS): integrating biomedical terminology. *Nucleic Acids Research*, 32(Database issue), D267–D270.
- Forrest CB, et al. (2014). PCORnet: a national patient-centered clinical research network. *Journal of the American Medical Informatics Association*, 21(4), 574–577.
- Mandl KD, et al. (2020). The SMART/HL7 FHIR-based ecosystem. *Journal of the American Medical Informatics Association*, 23(3), 447–452.

---

## License

MIT — see [LICENSE](LICENSE).

---

*Built as part of a Clinical Data Science portfolio targeting RWE Analyst roles in healthcare analytics. Author: Andrew Lee | [GitHub](https://github.com/SaeMind) | [LinkedIn](https://linkedin.com/in/agllee) | [ORCID](https://orcid.org/0009-0006-6489-3807)*
