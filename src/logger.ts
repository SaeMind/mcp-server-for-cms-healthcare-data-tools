/**
 * @file logger.ts
 * @description Structured logging with Winston. Provides a general-purpose
 * application logger and a dedicated audit logger for HIPAA-adjacent
 * compliance patterns (tool calls, data access, auth events).
 *
 * Audit log format is newline-delimited JSON for ingestion by SIEM/log
 * aggregation systems (Splunk, CloudWatch, Datadog).
 */

import winston from "winston";
import fs from "fs";
import path from "path";
import { config } from "./config.js";
import type { AuditEntry } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Ensure output directories exist
// ─────────────────────────────────────────────────────────────────────────────

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDir(config.AUDIT_LOG_PATH);
ensureDir(config.QUERY_LOG_PATH);

// ─────────────────────────────────────────────────────────────────────────────
// Common log format
// ─────────────────────────────────────────────────────────────────────────────

const jsonFormat = winston.format.combine(
  winston.format.timestamp({ format: "ISO" }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.colorize(),
  winston.format.printf(
    ({ timestamp, level, message, ...meta }) =>
      `${timestamp} [${level}] ${message}` +
      (Object.keys(meta).length > 0
        ? " " + JSON.stringify(meta, null, 0)
        : "")
  )
);

// ─────────────────────────────────────────────────────────────────────────────
// Application logger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * General-purpose application logger.
 * Writes to stdout (console) and a rotating file transport.
 */
export const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({
      filename: "./outputs/app.log",
      format: jsonFormat,
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit logger (NDJSON to dedicated file)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Audit logger — writes every data access event as newline-delimited JSON.
 * This log satisfies the data access audit trail requirement for systems
 * handling CMS-sourced healthcare data.
 *
 * Fields logged: requestId, timestamp, tool, datasetId, params (sanitized),
 * durationMs, rowsReturned, cacheHit, error (if any).
 *
 * NOTE: Never log PHI — params logged here are analyst query parameters,
 * not patient-level records.
 */
const auditTransport = new winston.transports.File({
  filename: config.AUDIT_LOG_PATH,
  format: jsonFormat,
  maxsize: 50 * 1024 * 1024, // 50 MB
  maxFiles: 10,
  tailable: true,
});

const auditLogger = winston.createLogger({
  level: "info",
  transports: [auditTransport],
});

/**
 * Write a structured audit entry for a tool call.
 *
 * @param entry - Structured audit log entry.
 */
export function writeAuditEntry(entry: AuditEntry): void {
  auditLogger.info("tool_call", { ...entry });
}

// ─────────────────────────────────────────────────────────────────────────────
// Query logger (separate file for query analytics)
// ─────────────────────────────────────────────────────────────────────────────

const queryLogger = winston.createLogger({
  level: "info",
  transports: [
    new winston.transports.File({
      filename: config.QUERY_LOG_PATH,
      format: jsonFormat,
      maxsize: 25 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
});

/**
 * Log a validated query execution for analytics and debugging.
 *
 * @param requestId - Unique request identifier.
 * @param dataset - Dataset queried.
 * @param params - Sanitized query parameters.
 * @param durationMs - Execution duration in milliseconds.
 * @param rowsReturned - Number of rows in result set.
 */
export function logQuery(
  requestId: string,
  dataset: string,
  params: Record<string, unknown>,
  durationMs: number,
  rowsReturned: number
): void {
  queryLogger.info("query_executed", {
    requestId,
    dataset,
    params,
    durationMs,
    rowsReturned,
    timestamp: new Date().toISOString(),
  });
}
