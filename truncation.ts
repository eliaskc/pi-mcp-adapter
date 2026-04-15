/**
 * Output truncation for MCP tool results.
 *
 * Uses pi's exported truncation utilities as recommended by the extension docs.
 * See: extensions.md § "Tools MUST truncate their output"
 */

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  truncateTail,
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
 * Apply tail truncation to MCP tool result text.
 *
 * Returns the (possibly truncated) text with an appended notice,
 * and structured details for the UI renderer.
 */
export function truncateToolOutput(text: string): {
  text: string;
  details: McpTruncationDetails;
} {
  const truncation = truncateTail(text);

  if (!truncation.truncated) {
    return { text: truncation.content, details: {} };
  }

  // Save full output to temp file
  const fullOutputPath = getTempFilePath();
  const stream = createWriteStream(fullOutputPath);
  stream.write(text);
  stream.end();

  let outputText = truncation.content;

  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;

  if (truncation.lastLinePartial) {
    const lastLineSize = formatSize(
      Buffer.byteLength(text.split("\n").pop() || "", "utf-8"),
    );
    outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${fullOutputPath}]`;
  } else if (truncation.truncatedBy === "lines") {
    outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
  } else {
    outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
  }

  return {
    text: outputText,
    details: { truncation, fullOutputPath },
  };
}

/**
 * Apply truncation to an array of content blocks.
 *
 * Concatenates all text blocks, applies tail truncation, and returns
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

function getTempFilePath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `pi-mcp-${id}.log`);
}
