/**
 * TUI render helpers for MCP tool results.
 *
 * Provides renderCall/renderResult handlers for both the proxy `mcp` tool
 * and direct MCP tools. Uses the same collapse/expand pattern (Ctrl+O)
 * as pi's built-in tools (bash, read, etc.).
 */

import {
  truncateToVisualLines,
  keyHint,
} from "@mariozechner/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, ToolRenderResultOptions, ToolRenderContext, AgentToolResult } from "@mariozechner/pi-coding-agent";
import { formatSize, DEFAULT_MAX_BYTES, type TruncationResult } from "./truncation.js";

/** Number of visual lines to show in collapsed mode. */
const PREVIEW_LINES = 5;

// ---------------------------------------------------------------------------
//  Proxy tool (mcp) — renderCall
// ---------------------------------------------------------------------------

interface ProxyParams {
  tool?: string;
  args?: string;
  connect?: string;
  describe?: string;
  search?: string;
  server?: string;
  action?: string;
}

export function renderProxyCall(
  args: ProxyParams,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const text = context.lastComponent ?? new Text("", 0, 0);

  let label: string;
  if (args.tool) {
    const serverHint = args.server ? ` (${args.server})` : "";
    label = theme.fg("toolTitle", theme.bold(`mcp ▸ ${args.tool}${serverHint}`));
  } else if (args.connect) {
    label = theme.fg("toolTitle", theme.bold(`mcp ▸ connect ${args.connect}`));
  } else if (args.describe) {
    label = theme.fg("toolTitle", theme.bold(`mcp ▸ describe ${args.describe}`));
  } else if (args.search) {
    label = theme.fg("toolTitle", theme.bold(`mcp ▸ search "${args.search}"`));
  } else if (args.server) {
    label = theme.fg("toolTitle", theme.bold(`mcp ▸ list ${args.server}`));
  } else if (args.action) {
    label = theme.fg("toolTitle", theme.bold(`mcp ▸ ${args.action}`));
  } else {
    label = theme.fg("toolTitle", theme.bold("mcp ▸ status"));
  }

  (text as Text).setText(label);
  return text;
}

// ---------------------------------------------------------------------------
//  Direct tool — renderCall
// ---------------------------------------------------------------------------

export function renderDirectCall(
  toolLabel: string,
  _args: unknown,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const text = context.lastComponent ?? new Text("", 0, 0);
  (text as Text).setText(theme.fg("toolTitle", theme.bold(toolLabel)));
  return text;
}

// ---------------------------------------------------------------------------
//  Shared renderResult — works for both proxy and direct tools
// ---------------------------------------------------------------------------

interface McpResultState {
  cachedWidth?: number;
  cachedLines?: string[];
  cachedSkipped?: number;
}

class McpResultRenderComponent extends Container {
  state: McpResultState = {};
}

function getResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text || "")
    .join("\n");
}

export function renderMcpResult(
  result: AgentToolResult<Record<string, unknown>>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const component = (context.lastComponent as McpResultRenderComponent) ?? new McpResultRenderComponent();
  const state = component.state;
  component.clear();

  const output = getResultText(result).trim();
  if (!output) return component;

  const styledOutput = output
    .split("\n")
    .map((line) => theme.fg("toolOutput", line))
    .join("\n");

  if (options.expanded) {
    component.addChild(new Text(`\n${styledOutput}`, 0, 0));
  } else {
    component.addChild({
      render: (width: number) => {
        if (state.cachedLines === undefined || state.cachedWidth !== width) {
          const preview = truncateToVisualLines(styledOutput, PREVIEW_LINES, width);
          state.cachedLines = preview.visualLines;
          state.cachedSkipped = preview.skippedCount;
          state.cachedWidth = width;
        }

        if (state.cachedSkipped && state.cachedSkipped > 0) {
          const hint =
            theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
            ` ${keyHint("app.tools.expand", "to expand")})`;
          return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
        }
        return ["", ...(state.cachedLines ?? [])];
      },
      invalidate: () => {
        state.cachedWidth = undefined;
        state.cachedLines = undefined;
        state.cachedSkipped = undefined;
      },
    } as Component);
  }

  // Data-truncation warning (when output was truncated before being sent to model)
  const details = result.details as Record<string, unknown> | undefined;
  const truncation = details?.truncation as TruncationResult | undefined;
  const fullOutputPath = details?.fullOutputPath as string | undefined;

  if (truncation?.truncated || fullOutputPath) {
    const warnings: string[] = [];
    if (fullOutputPath) {
      warnings.push(`Full output: ${fullOutputPath}`);
    }
    if (truncation?.truncated) {
      if (truncation.truncatedBy === "lines") {
        warnings.push(
          `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
        );
      } else {
        warnings.push(
          `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
        );
      }
    }
    component.addChild(
      new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0),
    );
  }

  return component;
}
