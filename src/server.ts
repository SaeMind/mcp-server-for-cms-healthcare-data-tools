/**
 * @file server.ts
 * @description CMS MCP Server — entry point.
 *
 * Implements the Model Context Protocol (MCP) server specification using
 * the official Anthropic MCP SDK. The server exposes CMS healthcare datasets
 * as callable tools within Claude conversations via stdio transport.
 *
 * Protocol: MCP (https://modelcontextprotocol.io/specification)
 * Transport: stdio (standard for Claude Desktop and Claude API tool use)
 *
 * Startup sequence:
 *  1. Load and validate environment configuration
 *  2. Initialize logger and cache
 *  3. Register MCP request handlers (tools/list, tools/call)
 *  4. Connect stdio transport
 *  5. Register graceful shutdown handlers (SIGTERM, SIGINT)
 *
 * Usage:
 *  $ node dist/server.js         (production)
 *  $ tsx src/server.ts           (development)
 *  $ docker-compose up           (containerized)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import http from "http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { closePool } from "./datasources.js";
import { flushCache } from "./cache.js";
import {
  TOOL_DEFINITIONS,
  handleListDatasets,
  handleGetSchema,
  handleGetData,
  handleRunQuery,
  handleCacheStatus,
  handleGetSampleQueries,
} from "./tools.js";

// ─────────────────────────────────────────────────────────────────────────────
// MCP Server initialization
// ─────────────────────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "cms-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Tool listing handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle MCP tools/list requests.
 * Returns the complete list of available tools with their input schemas.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  logger.debug("tools/list requested");
  return {
    tools: TOOL_DEFINITIONS,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool call handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle MCP tools/call requests.
 * Routes each tool call to the appropriate handler and returns structured results.
 *
 * The rate limit key defaults to "anonymous" in demo/development mode.
 * In production, extract the API key from request metadata as the bucket key
 * to enforce per-client rate limits.
 */
server.setRequestHandler(
  CallToolRequestSchema,
  // The installed SDK's type definitions for setRequestHandler incorrectly
  // require the return type to satisfy the union of ALL possible MCP result
  // shapes (e.g. ListToolsResult's `tools` field) rather than just the result
  // shape for this specific request schema. This is a known type-only defect
  // in @modelcontextprotocol/sdk — the runtime behavior is unaffected. The
  // cast below scopes the workaround to this single call site.
  (async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
  const { name, arguments: args } = request.params;

  // Use API key as rate limit bucket when present, else "anonymous"
  const rateLimitKey =
    typeof (args as Record<string, unknown>)?.api_key === "string"
      ? ((args as Record<string, unknown>).api_key as string)
      : "anonymous";

  logger.info("tools/call", { tool: name, rateLimitKey: rateLimitKey.slice(0, 8) + "..." });

  const safeArgs = (args as Record<string, unknown>) ?? {};

  switch (name) {
    case "list_datasets":
      return handleListDatasets(safeArgs, rateLimitKey);

    case "get_schema":
      return handleGetSchema(safeArgs, rateLimitKey);

    case "get_data":
      return handleGetData(safeArgs, rateLimitKey);

    case "run_query":
      return handleRunQuery(safeArgs, rateLimitKey);

    case "cache_status":
      return handleCacheStatus(safeArgs, rateLimitKey);

    case "get_sample_queries":
      return handleGetSampleQueries(safeArgs, rateLimitKey);

    default:
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${name}. Use list_datasets to see available tools.`
      );
  }
  }) as any
);

// ─────────────────────────────────────────────────────────────────────────────
// Health check HTTP endpoint (for Docker/Kubernetes probes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal HTTP server for health/liveness probes.
 * Separate from the MCP stdio transport — does not handle MCP requests.
 */
function startHealthServer(): http.Server {
  const healthServer = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "healthy",
          version: "1.0.0",
          mode: config.DEMO_MODE ? "demo" : "production",
          timestamp: new Date().toISOString(),
        })
      );
    } else if (req.url === "/metrics" && req.method === "GET") {
      // Basic Prometheus-compatible metrics
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(
        [
          `# HELP cms_mcp_server_up Server uptime indicator`,
          `# TYPE cms_mcp_server_up gauge`,
          `cms_mcp_server_up 1`,
          `# HELP cms_mcp_server_demo_mode Whether server is in demo mode`,
          `cms_mcp_server_demo_mode ${config.DEMO_MODE ? 1 : 0}`,
        ].join("\n") + "\n"
      );
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  healthServer.listen(config.PORT, () => {
    logger.info("Health server started", { port: config.PORT });
  });

  return healthServer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gracefully shut down all resources.
 * Called on SIGTERM and SIGINT to prevent data corruption and connection leaks.
 *
 * @param signal - Signal name for logging.
 * @param healthServer - HTTP health server to close.
 */
async function shutdown(signal: string, healthServer?: http.Server): Promise<void> {
  logger.info(`Received ${signal} — shutting down`, {});

  try {
    // Close database pool
    await closePool();

    // Flush cache (log summary, not strictly required)
    flushCache();

    // Close health server
    if (healthServer) {
      await new Promise<void>((resolve) =>
        healthServer.close(() => resolve())
      );
    }

    logger.info("Shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error("Shutdown error", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Server entrypoint.
 * Connects the MCP server to the stdio transport and starts the health server.
 */
async function main(): Promise<void> {
  logger.info("Starting CMS MCP Server", {
    version: "1.0.0",
    mode: config.DEMO_MODE ? "demo" : "production",
    logLevel: config.LOG_LEVEL,
    rateLimitRpm: config.RATE_LIMIT_REQUESTS_PER_MIN,
    authEnabled: !!config.MCP_API_KEY,
  });

  // Start health/metrics HTTP server
  const healthServer = startHealthServer();

  // Register shutdown handlers
  process.on("SIGTERM", () => shutdown("SIGTERM", healthServer));
  process.on("SIGINT", () => shutdown("SIGINT", healthServer));

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", { error: err.message, stack: err.stack });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", { reason: String(reason) });
    process.exit(1);
  });

  // Connect MCP stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("CMS MCP Server ready — listening on stdio");

  if (config.DEMO_MODE) {
    logger.warn(
      "Running in DEMO MODE — using embedded sample data. " +
        "Set DEMO_MODE=false and configure DATABASE_URL for production use."
    );
  }
}

main().catch((err) => {
  logger.error("Failed to start server", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
