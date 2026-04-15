/**
 * Output truncation for MCP tool results.
 *
 * Two layers:
 * 1. Data truncation — limits what goes back to the model (2000 lines / 50KB).
 *    Full output is saved to a temp file when truncated.
 * 2. UI truncation — renderCall/renderResult handlers that collapse/expand
 *    long results in the TUI (Ctrl+O).
 *
 * The truncation logic is inlined here (from pi's truncate.ts) to avoid a
 * hard runtime dependency on @mariozechner/pi-coding-agent, which is not
 * available in the test environment.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock } from "./types.js";

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface McpTruncationDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

// ---------------------------------------------------------------------------
//  Inlined truncation utilities (from pi's truncate.ts)
// ---------------------------------------------------------------------------

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.slice(start).toString("utf-8");
}

interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      maxLines,
      maxBytes,
    };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let lastLinePartial = false;

  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (outputLinesArr.length === 0) {
        const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
        outputLinesArr.unshift(truncatedLine);
        outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
        lastLinePartial = true;
      }
      break;
    }
    outputLinesArr.unshift(line);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = outputLinesArr.join("\n");
  const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    lastLinePartial,
    maxLines,
    maxBytes,
  };
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

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
