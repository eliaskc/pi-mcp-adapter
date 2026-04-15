import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// Mock pi-coding-agent's truncation exports so truncation.ts can load in tests
vi.mock("@mariozechner/pi-coding-agent", () => {
  const DEFAULT_MAX_LINES = 2000;
  const DEFAULT_MAX_BYTES = 50 * 1024;

  function formatSize(bytes: number): string {
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

  function truncateTail(content: string, options: { maxLines?: number; maxBytes?: number } = {}) {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const totalBytes = Buffer.byteLength(content, "utf-8");
    const lines = content.split("\n");
    const totalLines = lines.length;

    if (totalLines <= maxLines && totalBytes <= maxBytes) {
      return {
        content, truncated: false, truncatedBy: null,
        totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes,
        lastLinePartial: false, firstLineExceedsLimit: false, maxLines, maxBytes,
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
      content: outputContent, truncated: true, truncatedBy,
      totalLines, totalBytes, outputLines: outputLinesArr.length,
      outputBytes: finalOutputBytes, lastLinePartial,
      firstLineExceedsLimit: false, maxLines, maxBytes,
    };
  }

  return { truncateTail, formatSize, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES };
});

import {
  truncateToolOutput,
  truncateContentBlocks,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  formatSize,
} from "../truncation.js";

describe("truncateToolOutput", () => {
  it("returns content unchanged when within limits", () => {
    const input = "hello world\nline 2\nline 3";
    const result = truncateToolOutput(input);
    expect(result.text).toBe(input);
    expect(result.details.truncation).toBeUndefined();
    expect(result.details.fullOutputPath).toBeUndefined();
  });

  it("truncates by line count and saves full output to temp file", async () => {
    const lines = Array.from({ length: DEFAULT_MAX_LINES + 500 }, (_, i) => `line ${i + 1}`);
    const input = lines.join("\n");
    const result = truncateToolOutput(input);

    expect(result.details.truncation).toBeDefined();
    expect(result.details.truncation!.truncated).toBe(true);
    expect(result.details.truncation!.truncatedBy).toBe("lines");
    expect(result.details.truncation!.outputLines).toBe(DEFAULT_MAX_LINES);
    expect(result.details.truncation!.totalLines).toBe(lines.length);

    // Full output saved to temp file
    expect(result.details.fullOutputPath).toBeDefined();
    expect(result.text).toContain(`Full output: ${result.details.fullOutputPath}`);

    // Since it's tail truncation, the last line should be preserved
    expect(result.text).toContain(`line ${lines.length}`);
    // First line should NOT be in output
    expect(result.text).not.toContain("line 1\n");

    // Verify temp file contains full output
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (result.details.fullOutputPath) {
      expect(existsSync(result.details.fullOutputPath)).toBe(true);
      const fullContent = readFileSync(result.details.fullOutputPath, "utf-8");
      expect(fullContent).toBe(input);
    }
  });

  it("truncates by byte size", () => {
    const bigLine = "x".repeat(1000);
    const lines = Array.from({ length: 100 }, () => bigLine);
    const input = lines.join("\n");
    expect(Buffer.byteLength(input, "utf-8")).toBeGreaterThan(DEFAULT_MAX_BYTES);

    const result = truncateToolOutput(input);
    expect(result.details.truncation).toBeDefined();
    expect(result.details.truncation!.truncated).toBe(true);
    expect(result.details.truncation!.truncatedBy).toBe("bytes");
    expect(result.details.fullOutputPath).toBeDefined();
    expect(result.text).toContain("limit)");
  });
});

describe("truncateContentBlocks", () => {
  it("returns content unchanged when within limits", () => {
    const blocks = [
      { type: "text" as const, text: "hello" },
      { type: "text" as const, text: "world" },
    ];
    const result = truncateContentBlocks(blocks);
    expect(result.truncationDetails.truncation).toBeUndefined();
    expect(result.content.length).toBe(1);
    expect((result.content[0] as { text: string }).text).toBe("hello\nworld");
  });

  it("preserves non-text blocks", () => {
    const blocks = [
      { type: "text" as const, text: "hello" },
      { type: "image" as const, data: "base64data", mimeType: "image/png" },
    ];
    const result = truncateContentBlocks(blocks);
    expect(result.content.length).toBe(2);
    expect(result.content[0].type).toBe("text");
    expect(result.content[1].type).toBe("image");
  });

  it("truncates large text content and preserves images", () => {
    const lines = Array.from({ length: DEFAULT_MAX_LINES + 100 }, (_, i) => `line ${i + 1}`);
    const blocks = [
      { type: "text" as const, text: lines.join("\n") },
      { type: "image" as const, data: "base64data", mimeType: "image/png" },
    ];
    const result = truncateContentBlocks(blocks);
    expect(result.truncationDetails.truncation).toBeDefined();
    expect(result.truncationDetails.truncation!.truncated).toBe(true);
    expect(result.content.some((b) => b.type === "image")).toBe(true);
    const textBlock = result.content.find((b) => b.type === "text") as { text: string };
    expect(textBlock).toBeDefined();
    expect(textBlock.text).toContain("Full output:");
  });

  it("returns content as-is when no text blocks", () => {
    const blocks = [
      { type: "image" as const, data: "base64data", mimeType: "image/png" },
    ];
    const result = truncateContentBlocks(blocks);
    expect(result.content).toEqual(blocks);
    expect(result.truncationDetails.truncation).toBeUndefined();
  });
});

describe("formatSize", () => {
  it("formats bytes", () => {
    expect(formatSize(500)).toBe("500B");
  });
  it("formats kilobytes", () => {
    expect(formatSize(1024)).toBe("1.0KB");
    expect(formatSize(51200)).toBe("50.0KB");
  });
  it("formats megabytes", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0MB");
  });
});
