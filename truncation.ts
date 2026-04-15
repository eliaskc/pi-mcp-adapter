/**
 * Output truncation for MCP tool results.
 *
 * TODO: The TUI collapsed preview currently shows the full (truncated) text
 * because we rely on pi's default renderer. To get proper collapsed/expanded
 * behavior (show first N visual lines, "X more lines, Ctrl+O to expand"),
 * register a renderResult that uses pi's truncateToVisualLines(). See
 * examples/extensions/truncated-tool.ts in pi-coding-agent for the pattern.
 *
 * Uses pi's exported truncation utilities as recommended by the extension docs.
 * See: extensions.md § "Tools MUST truncate their output"
 */

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  truncateHead,
  formatSize,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import type { ContentBlock } from "./types.js";

export { DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, formatSize, type TruncationResult };

export interface McpTruncationDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

/**
 * Apply head truncation to MCP tool result text — keeps the first N lines/bytes.
 *
 * MCP tool results are document-like (guides, lists, structured data) where the
 * beginning is most important, unlike bash output where the end matters.
 *
 * Returns the (possibly truncated) text with an appended notice,
 * and structured details for the UI renderer.
 */
export function truncateToolOutput(text: string): {
  text: string;
  details: McpTruncationDetails;
} {
  const truncation = truncateHead(text);

  if (!truncation.truncated) {
    return { text: truncation.content, details: {} };
  }

  // Save full output to temp file
  const fullOutputPath = getTempFilePath();
  writeFileSync(fullOutputPath, text, "utf-8");

  let outputText: string;
  const endLine = truncation.outputLines;

  if (truncation.firstLineExceedsLimit) {
    // Single huge line (e.g. minified JSON) — truncate the line itself to the byte limit
    outputText = truncateStringToBytes(text, DEFAULT_MAX_BYTES);
    outputText += `\n\n[Showing first ${formatSize(DEFAULT_MAX_BYTES)} of line 1 (line is ${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}]`;
  } else if (truncation.lastLinePartial) {
    outputText = truncation.content;
    const firstLineSize = formatSize(
      Buffer.byteLength(text.split("\n")[0] || "", "utf-8"),
    );
    outputText += `\n\n[Showing first ${formatSize(truncation.outputBytes)} of line 1 (line is ${firstLineSize}). Full output: ${fullOutputPath}]`;
  } else {
    outputText = truncation.content;
    if (truncation.truncatedBy === "lines") {
      outputText += `\n\n[Showing lines 1-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
    } else {
      outputText += `\n\n[Showing lines 1-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
    }
  }

  return {
    text: outputText,
    details: { truncation, fullOutputPath },
  };
}

/**
 * Apply truncation to an array of content blocks.
 *
 * Concatenates all text blocks, applies head truncation, and returns
 * a new content array with the truncated text + any non-text blocks preserved.
 * Also returns truncation details for the UI renderer.
 */
export function truncateContentBlocks(content: ContentBlock[]): {
  content: ContentBlock[];
  truncationDetails: McpTruncationDetails;
} {
  const textParts: string[] = [];
  const nonTextBlocks: ContentBlock[] = [];

  for (const block of content) {
    if (block.type === "text") {
      textParts.push((block as { text: string }).text);
    } else {
      nonTextBlocks.push(block);
    }
  }

  if (textParts.length === 0) {
    return { content, truncationDetails: {} };
  }

  const fullText = textParts.join("\n");
  const { text: truncatedText, details } = truncateToolOutput(fullText);

  const result: ContentBlock[] = [
    { type: "text" as const, text: truncatedText },
    ...nonTextBlocks,
  ];

  return { content: result, truncationDetails: details };
}

function truncateStringToBytes(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;
  // Walk back from maxBytes to avoid splitting a multi-byte UTF-8 character
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return buf.slice(0, end).toString("utf-8");
}

function getTempFilePath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `pi-mcp-${id}.log`);
}
