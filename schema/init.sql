-- =============================================================================
-- CMS MCP Server — PostgreSQL Schema
-- Run automatically by Docker entrypoint when database is first created.
-- For manual setup: psql -U cms_user -d cms_data -f schema/init.sql
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS cms;

-- ─────────────────────────────────────────────────────────────────────────────
-- HCC Risk Adjustment (CMS-HCC V28)
-- Source: https://www.cms.gov/medicare/hcc
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cms.hcc_risk_adjustment (
    id                      SERIAL PRIMARY KEY,
    icd_code                VARCHAR(10)     NOT NULL,
    icd_description         TEXT            NOT NULL,
    hcc_category            INTEGER         NOT NULL,
    hcc_description         TEXT            NOT NULL,
    relative_factor_dual    NUMERIC(6, 4)   NOT NULL,
    relative_factor_nondual NUMERIC(6, 4)   NOT NULL,
    model_year              INTEGER         NOT NULL DEFAULT 2024,
    hierarchy_group         VARCHAR(64)     NOT NULL,
    created_at              TIMESTAMP       NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_hcc_icd_year UNIQUE (icd_code, model_year)
);

CREATE INDEX IF NOT EXISTS idx_hcc_icd_code
    ON cms.hcc_risk_adjustment (icd_code);
CREATE INDEX IF NOT EXISTS idx_hcc_category
    ON cms.hcc_risk_adjustment (hcc_category);
CREATE INDEX IF NOT EXISTS idx_hcc_model_year
    ON cms.hcc_risk_adjustment (model_year);
CREATE INDEX IF NOT EXISTS idx_hcc_factor_nondual
    ON cms.hcc_risk_adjustment (relative_factor_nondual);

COMMENT ON TABLE cms.hcc_risk_adjustment IS
    'CMS-HCC V28 ICD-10 to HCC category mapping with relative risk factors. '
    'Load from: https://www.cms.gov/medicare/hcc/downloads';

-- ─────────────────────────────────────────────────────────────────────────────
-- Hospital Readmission (HCUP AHRQ)
-- Source: https://www.qualityindicators.ahrq.gov
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cms.hospital_readmission (
    id                   SERIAL PRIMARY KEY,
    hospital_ccn         VARCHAR(6)      NOT NULL,
    hospital_name        VARCHAR(256)    NOT NULL,
    state                CHAR(2)         NOT NULL,
    measure_id           VARCHAR(32)     NOT NULL,
    measure_name         VARCHAR(256)    NOT NULL,
    denominator          INTEGER         NOT NULL DEFAULT 0,
    numerator            INTEGER         NOT NULL DEFAULT 0,
    readmission_rate     NUMERIC(6, 4)   NOT NULL,
    national_rate        NUMERIC(6, 4)   NOT NULL,
    performance_category VARCHAR(16)     NOT NULL
        CHECK (performance_category IN ('better', 'same', 'worse', 'not_available')),
    reporting_period     VARCHAR(21)     NOT NULL,
    created_at           TIMESTAMP       NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_readmission_ccn_measure_period UNIQUE (hospital_ccn, measure_id, reporting_period)
);

CREATE INDEX IF NOT EXISTS idx_readm_state
    ON cms.hospital_readmission (state);
CREATE INDEX IF NOT EXISTS idx_readm_measure
    ON cms.hospital_readmission (measure_id);
CREATE INDEX IF NOT EXISTS idx_readm_ccn
    ON cms.hospital_readmission (hospital_ccn);
CREATE INDEX IF NOT EXISTS idx_readm_rate
    ON cms.hospital_readmission (readmission_rate);
CREATE INDEX IF NOT EXISTS idx_readm_name
    ON cms.hospital_readmission USING gin(to_tsvector('english', hospital_name));

COMMENT ON TABLE cms.hospital_readmission IS
    'Hospital-level 30-day readmission rates from HCUP AHRQ Quality Indicators. '
    'Load from: https://www.qualityindicators.ahrq.gov/Downloads/Modules';

-- ─────────────────────────────────────────────────────────────────────────────
-- MIPS Quality Measures (CMS Quality Payment Program)
-- Source: https://qpp.cms.gov/api/data
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cms.mips_quality_measures (
    id               SERIAL PRIMARY KEY,
    npi              CHAR(10)        NOT NULL,
    provider_name    VARCHAR(256)    NOT NULL,
    specialty        VARCHAR(128)    NOT NULL,
    measure_id       VARCHAR(8)      NOT NULL,
    measure_name     TEXT            NOT NULL,
    measure_category VARCHAR(64)     NOT NULL,
    denominator      INTEGER         NOT NULL DEFAULT 0,
    numerator        INTEGER         NOT NULL DEFAULT 0,
    performance_rate NUMERIC(6, 4)   NOT NULL,
    reporting_year   INTEGER         NOT NULL,
    measure_type     VARCHAR(32)     NOT NULL
        CHECK (measure_type IN ('process', 'outcome', 'patient_experience', 'efficiency')),
    created_at       TIMESTAMP       NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_mips_npi_measure_year UNIQUE (npi, measure_id, reporting_year)
);

CREATE INDEX IF NOT EXISTS idx_mips_npi
    ON cms.mips_quality_measures (npi);
CREATE INDEX IF NOT EXISTS idx_mips_measure_id
    ON cms.mips_quality_measures (measure_id);
CREATE INDEX IF NOT EXISTS idx_mips_specialty
    ON cms.mips_quality_measures (specialty);
CREATE INDEX IF NOT EXISTS idx_mips_performance
    ON cms.mips_quality_measures (performance_rate);
CREATE INDEX IF NOT EXISTS idx_mips_year
    ON cms.mips_quality_measures (reporting_year);

COMMENT ON TABLE cms.mips_quality_measures IS
    'MIPS Quality Payment Program provider-level performance data. '
    'Load from: https://qpp.cms.gov/api/data/docs';

-- ─────────────────────────────────────────────────────────────────────────────
-- Medicare Part D Drug Utilization
-- Source: https://data.cms.gov/summary-statistics-on-use-and-payments
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cms.partd_drug_utilization (
    id                   SERIAL PRIMARY KEY,
    drug_name            VARCHAR(256)    NOT NULL,
    generic_name         VARCHAR(256)    NOT NULL,
    brand_name           VARCHAR(256),
    drug_class           VARCHAR(128)    NOT NULL,
    total_claims         INTEGER         NOT NULL DEFAULT 0,
    total_beneficiaries  INTEGER         NOT NULL DEFAULT 0,
    total_day_coverage   BIGINT          NOT NULL DEFAULT 0,
    total_drug_cost      NUMERIC(18, 2)  NOT NULL DEFAULT 0,
    avg_cost_per_claim   NUMERIC(10, 2)  NOT NULL DEFAULT 0,
    avg_cost_per_day     NUMERIC(10, 4)  NOT NULL DEFAULT 0,
    reporting_year       INTEGER         NOT NULL,
    state                CHAR(2)         NOT NULL,
    created_at           TIMESTAMP       NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_partd_drug_state_year UNIQUE (generic_name, state, reporting_year)
);

CREATE INDEX IF NOT EXISTS idx_partd_generic_name
    ON cms.partd_drug_utilization USING gin(to_tsvector('english', generic_name));
CREATE INDEX IF NOT EXISTS idx_partd_drug_class
    ON cms.partd_drug_utilization (drug_class);
CREATE INDEX IF NOT EXISTS idx_partd_state
    ON cms.partd_drug_utilization (state);
CREATE INDEX IF NOT EXISTS idx_partd_total_cost
    ON cms.partd_drug_utilization (total_drug_cost DESC);
CREATE INDEX IF NOT EXISTS idx_partd_year
    ON cms.partd_drug_utilization (reporting_year);

COMMENT ON TABLE cms.partd_drug_utilization IS
    'Medicare Part D Prescriber Public Use File — drug utilization and cost. '
    'Load from: https://data.cms.gov/provider-summary-by-type-of-service/medicare-part-d-prescribers';

-- ─────────────────────────────────────────────────────────────────────────────
-- Grant read-only access to application user
-- ─────────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA cms TO cms_user;
GRANT SELECT ON ALL TABLES IN SCHEMA cms TO cms_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA cms GRANT SELECT ON TABLES TO cms_user;
