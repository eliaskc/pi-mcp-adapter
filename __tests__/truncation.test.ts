import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  truncateHead: vi.fn(),
  formatSize: vi.fn((bytes: number) => `size:${bytes}`),
  DEFAULT_MAX_LINES: 2000,
  DEFAULT_MAX_BYTES: 50 * 1024,
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  truncateHead: mocks.truncateHead,
  formatSize: mocks.formatSize,
  DEFAULT_MAX_LINES: mocks.DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES: mocks.DEFAULT_MAX_BYTES,
}));

import {
  truncateToolOutput,
  truncateContentBlocks,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
} from "../truncation.js";

describe("truncation", () => {
  beforeEach(() => {
    mocks.truncateHead.mockReset();
    mocks.formatSize.mockClear();
  });

  describe("truncateToolOutput", () => {
    it("returns content unchanged when truncateHead does not truncate", () => {
      mocks.truncateHead.mockReturnValue({
        content: "hello world\nline 2",
        truncated: false,
      });

      const result = truncateToolOutput("hello world\nline 2");

      expect(mocks.truncateHead).toHaveBeenCalledWith("hello world\nline 2");
      expect(result).toEqual({
        text: "hello world\nline 2",
        details: {},
      });
    });

    it("writes full output and appends a line-truncation notice", () => {
      mocks.truncateHead.mockReturnValue({
        content: "head output",
        truncated: true,
        truncatedBy: "lines",
        totalLines: 2500,
        outputLines: 2000,
        outputBytes: 123,
        lastLinePartial: false,
      });

      const input = "full\noutput";
      const result = truncateToolOutput(input);

      expect(result.details.truncation).toMatchObject({
        truncated: true,
        truncatedBy: "lines",
        totalLines: 2500,
        outputLines: 2000,
      });
      expect(result.details.fullOutputPath).toMatch(/pi-mcp-.*\.log$/);
      expect(result.text).toContain("head output");
      expect(result.text).toContain("[Showing lines 1-2000 of 2500.");
      expect(result.text).toContain(`Full output: ${result.details.fullOutputPath}]`);
      expect(existsSync(result.details.fullOutputPath!)).toBe(true);
      expect(readFileSync(result.details.fullOutputPath!, "utf-8")).toBe(input);
    });

    it("appends a byte-truncation notice using formatSize", () => {
      mocks.truncateHead.mockReturnValue({
        content: "head output",
        truncated: true,
        truncatedBy: "bytes",
        totalLines: 100,
        outputLines: 40,
        outputBytes: 4096,
        lastLinePartial: false,
      });

      const result = truncateToolOutput("x".repeat(DEFAULT_MAX_BYTES + 1));

      expect(mocks.formatSize).toHaveBeenCalledWith(DEFAULT_MAX_BYTES);
      expect(result.text).toContain("[Showing lines 1-40 of 100 (size:51200 limit).");
    });

    it("appends a partial-first-line notice", () => {
      mocks.truncateHead.mockReturnValue({
        content: "partial head",
        truncated: true,
        truncatedBy: "bytes",
        totalLines: 1,
        outputLines: 1,
        outputBytes: 32,
        lastLinePartial: true,
        firstLineExceedsLimit: false,
      });

      const result = truncateToolOutput("abcdef");

      expect(mocks.formatSize).toHaveBeenCalledWith(32);
      expect(mocks.formatSize).toHaveBeenCalledWith(6);
      expect(result.text).toContain("[Showing first size:32 of line 1 (line is size:6).");
    });

    it("handles firstLineExceedsLimit by truncating the line to byte limit", () => {
      mocks.truncateHead.mockReturnValue({
        content: "",
        truncated: true,
        truncatedBy: "bytes",
        totalLines: 1,
        totalBytes: 60000,
        outputLines: 0,
        outputBytes: 0,
        lastLinePartial: false,
        firstLineExceedsLimit: true,
      });

      const bigLine = "x".repeat(60000);
      const result = truncateToolOutput(bigLine);

      expect(result.details.truncation).toMatchObject({ firstLineExceedsLimit: true });
      expect(result.details.fullOutputPath).toMatch(/pi-mcp-.*\.log$/);
      // Should contain truncated content (not empty)
      expect(result.text.length).toBeGreaterThan(100);
      expect(result.text).toContain("[Showing first");
      expect(result.text).toContain("of line 1");
    });
  });

  describe("truncateContentBlocks", () => {
    it("returns content as-is when there are no text blocks", () => {
      const blocks = [
        { type: "image" as const, data: "base64data", mimeType: "image/png" },
      ];

      const result = truncateContentBlocks(blocks);

      expect(mocks.truncateHead).not.toHaveBeenCalled();
      expect(result).toEqual({ content: blocks, truncationDetails: {} });
    });

    it("joins text blocks before truncating", () => {
      mocks.truncateHead.mockReturnValue({
        content: "hello\nworld",
        truncated: false,
      });

      const blocks = [
        { type: "text" as const, text: "hello" },
        { type: "text" as const, text: "world" },
      ];

      const result = truncateContentBlocks(blocks);

      expect(mocks.truncateHead).toHaveBeenCalledWith("hello\nworld");
      expect(result).toEqual({
        content: [{ type: "text", text: "hello\nworld" }],
        truncationDetails: {},
      });
    });

    it("preserves non-text blocks after truncating text", () => {
      mocks.truncateHead.mockReturnValue({
        content: "truncated text",
        truncated: true,
        truncatedBy: "lines",
        totalLines: 10,
        outputLines: 3,
        outputBytes: 42,
        lastLinePartial: false,
      });

      const blocks = [
        { type: "text" as const, text: "hello" },
        { type: "image" as const, data: "base64data", mimeType: "image/png" },
      ];

      const result = truncateContentBlocks(blocks);

      expect(result.truncationDetails.truncation).toMatchObject({ truncated: true });
      expect(result.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining("truncated text"),
        },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ]);
    });
  });

  it("re-exports pi truncation defaults", () => {
    expect(DEFAULT_MAX_LINES).toBe(mocks.DEFAULT_MAX_LINES);
    expect(DEFAULT_MAX_BYTES).toBe(mocks.DEFAULT_MAX_BYTES);
  });
});
