import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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
    // (Give the write stream a moment to flush)
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (result.details.fullOutputPath) {
      expect(existsSync(result.details.fullOutputPath)).toBe(true);
      const fullContent = readFileSync(result.details.fullOutputPath, "utf-8");
      expect(fullContent).toBe(input);
    }
  });

  it("truncates by byte size", () => {
    // Create content that exceeds byte limit but not line limit
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
    // Text blocks get merged into one
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
    // Image block preserved
    expect(result.content.some((b) => b.type === "image")).toBe(true);
    // Text block truncated
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
