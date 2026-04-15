const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const fs = require("fs-extra");
const path = require("path");

// Require our trading logic
const { ALL_TICKERS, runAnalysis } = require("./index.js");

const STATE_FILE = path.join(__dirname, 'state.json');

const server = new McpServer({
  name: "BX Trader Bot MCP",
  version: "1.0.0",
});

// Tool: Get status of a specific ticker
server.tool(
  "get_ticker_status",
  "Get the current analysis status for a stock ticker",
  {
    ticker: z.string().describe("The stock ticker symbol (e.g., TSLA, AAPL)"),
  },
  async ({ ticker }) => {
    try {
      const state = await fs.readJson(STATE_FILE).catch(() => ({}));
      const entry = state[ticker.toUpperCase()];
      if (entry) {
        const status = typeof entry === 'string' ? entry : entry.decision;
        const reason = entry.reason || "N/A";
        const news = entry.sentiment?.text || "N/A";
        return {
          content: [{ type: "text", text: `Status for ${ticker.toUpperCase()}: ${status}\nReason: ${reason}\nRecent News: ${news}` }],
        };
      } else {
        return {
          content: [{ type: "text", text: `Ticker ${ticker.toUpperCase()} not found in current analysis. Current tickers are: ${ALL_TICKERS.slice(0, 10).join(", ")}...` }],
        };
      }
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error reading state: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: List all tickers and statuses
server.tool(
  "list_all_tickers",
  "List all tickers and their current analysis status",
  {},
  async () => {
    try {
      const state = await fs.readJson(STATE_FILE).catch(() => ({}));
      const summary = Object.entries(state)
        .map(([ticker, entry]) => {
            const status = typeof entry === 'string' ? entry : entry.decision;
            return `${ticker}: ${status}`;
        })
        .join("\n");
      return {
        content: [{ type: "text", text: summary || "No tickers analyzed yet." }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error reading state: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// Tool: Trigger Manual Scan
server.tool(
  "trigger_manual_scan",
  "Triggers a fresh scan of all tickers via Polygon API",
  {},
  async () => {
    // This will start the scan in the current process.
    // Note: It might take a long time due to rate limits.
    // We run it as background task and return immediately
    runAnalysis(false).catch(err => console.error("Background scan error:", err));
    
    return {
      content: [{ type: "text", text: "Manual scan triggered in background. Use list_all_tickers or get_ticker_status to check progress later. Total tickers: " + ALL_TICKERS.length }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error in MCP server:", error);
  process.exit(1);
});
