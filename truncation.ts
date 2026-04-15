import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text } from "@mariozechner/pi-tui";
import type { ContentBlock } from "./types.js";

// Mirror Pi's built-in truncation defaults.
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;
const MCP_PREVIEW_LINES = 5;

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface TruncationDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Mirrors Pi's truncateHead behavior — keeps the first N lines/bytes.
export function truncateHead(content: string, options: { maxLines?: number; maxBytes?: number } = {}): TruncationResult {
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
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let lastLinePartial = false;

  for (let i = 0; i < lines.length && outputLinesArr.length < maxLines; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (outputLinesArr.length === 0) {
        const truncatedLine = truncateStringToBytesFromStart(line, maxBytes);
        outputLinesArr.push(truncatedLine);
        outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
        lastLinePartial = true;
      }
      break;
    }

    outputLinesArr.push(line);
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
    firstLineExceedsLimit: outputLinesArr.length === 1 && lastLinePartial,
    maxLines,
    maxBytes,
  };
}

export function truncateContentForModel(content: ContentBlock[]): {
  content: ContentBlock[];
  details: TruncationDetails;
} {
  const textBlocks = content.filter((block) => block.type === "text");
  if (textBlocks.length === 0) {
    return { content, details: {} };
  }

  const fullText = textBlocks.map((block) => block.text ?? "").join("\n");
  const truncation = truncateHead(fullText);

  if (!truncation.truncated) {
    return { content, details: {} };
  }

  const fullOutputPath = getTempFilePath();
  writeFileSync(fullOutputPath, fullText, "utf-8");

  let outputText = truncation.content || "(empty result)";
  const endLine = truncation.outputLines;

  if (truncation.lastLinePartial) {
    const firstLineSize = formatSize(Buffer.byteLength(fullText.split("\n")[0] || "", "utf-8"));
    outputText += `\n\n[Showing first ${formatSize(truncation.outputBytes)} of line 1 (line is ${firstLineSize}). Full output: ${fullOutputPath}]`;
  } else if (truncation.truncatedBy === "lines") {
    outputText += `\n\n[Showing lines 1-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
  } else {
    outputText += `\n\n[Showing lines 1-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
  }

  const otherBlocks = content.filter((block) => block.type !== "text");
  return {
    content: [{ type: "text", text: outputText }, ...otherBlocks],
    details: { truncation, fullOutputPath },
  };
}

export function renderTruncatedToolResult(
  result: { content: ContentBlock[]; details?: TruncationDetails },
  options: { expanded: boolean; isPartial: boolean },
  theme: { fg: (color: string, text: string) => string },
  context: { showImages: boolean },
) {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "Working..."), 0, 0);
  }

  let text = "";
  const output = getResultText(result, context.showImages).trim();

  if (output) {
    const outputLines = output.split("\n");
    const displayLines = options.expanded ? outputLines : outputLines.slice(0, MCP_PREVIEW_LINES);

    text += displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");

    if (!options.expanded && outputLines.length > MCP_PREVIEW_LINES) {
      text += "\n";
      text += theme.fg("muted", `... (${outputLines.length - MCP_PREVIEW_LINES} more lines, Ctrl+O to expand)`);
    }
  }

  const truncation = result.details?.truncation;
  const fullOutputPath = result.details?.fullOutputPath;
  if (truncation?.truncated || fullOutputPath) {
    const warnings: string[] = [];
    if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
    if (truncation?.truncated) {
      if (truncation.truncatedBy === "lines") {
        warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
      } else {
        warnings.push(`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`);
      }
    }
    if (text) text += "\n\n";
    text += theme.fg("warning", `[${warnings.join(". ")}]`);
  }

  return new Text(text, 0, 0);
}

function getResultText(result: { content: ContentBlock[] }, showImages: boolean): string {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");

  if (showImages) {
    return text;
  }

  const images = result.content
    .filter((block) => block.type === "image")
    .map((block) => `[Image: ${block.mimeType ?? "image/unknown"}]`)
    .join("\n");

  if (!text) return images;
  if (!images) return text;
  return `${text}\n${images}`;
}

function truncateStringToBytesFromStart(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;

  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return buf.slice(0, end).toString("utf-8");
}

function getTempFilePath(): string {
  return join(tmpdir(), `pi-mcp-${randomBytes(8).toString("hex")}.log`);
}
