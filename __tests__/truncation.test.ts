import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  truncateTail: vi.fn(),
  formatSize: vi.fn((bytes: number) => `size:${bytes}`),
  DEFAULT_MAX_LINES: 2000,
  DEFAULT_MAX_BYTES: 50 * 1024,
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  truncateTail: mocks.truncateTail,
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
    mocks.truncateTail.mockReset();
    mocks.formatSize.mockClear();
  });

  describe("truncateToolOutput", () => {
    it("returns content unchanged when truncateTail does not truncate", () => {
      mocks.truncateTail.mockReturnValue({
        content: "hello world\nline 2",
        truncated: false,
      });

      const result = truncateToolOutput("hello world\nline 2");

      expect(mocks.truncateTail).toHaveBeenCalledWith("hello world\nline 2");
      expect(result).toEqual({
        text: "hello world\nline 2",
        details: {},
      });
    });

    it("writes full output and appends a line-truncation notice", () => {
      mocks.truncateTail.mockReturnValue({
        content: "tail output",
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
      expect(result.text).toContain("tail output");
      expect(result.text).toContain("[Showing lines 501-2500 of 2500.");
      expect(result.text).toContain(`Full output: ${result.details.fullOutputPath}]`);
      expect(existsSync(result.details.fullOutputPath!)).toBe(true);
      expect(readFileSync(result.details.fullOutputPath!, "utf-8")).toBe(input);
    });

    it("appends a byte-truncation notice using formatSize", () => {
      mocks.truncateTail.mockReturnValue({
        content: "tail output",
        truncated: true,
        truncatedBy: "bytes",
        totalLines: 100,
        outputLines: 40,
        outputBytes: 4096,
        lastLinePartial: false,
      });

      const result = truncateToolOutput("x".repeat(DEFAULT_MAX_BYTES + 1));

      expect(mocks.formatSize).toHaveBeenCalledWith(DEFAULT_MAX_BYTES);
      expect(result.text).toContain("[Showing lines 61-100 of 100 (size:51200 limit).");
    });

    it("appends a partial-last-line notice", () => {
      mocks.truncateTail.mockReturnValue({
        content: "partial tail",
        truncated: true,
        truncatedBy: "bytes",
        totalLines: 1,
        outputLines: 1,
        outputBytes: 32,
        lastLinePartial: true,
      });

      const result = truncateToolOutput("abcdef");

      expect(mocks.formatSize).toHaveBeenCalledWith(32);
      expect(mocks.formatSize).toHaveBeenCalledWith(6);
      expect(result.text).toContain("[Showing last size:32 of line 1 (line is size:6).");
    });
  });

  describe("truncateContentBlocks", () => {
    it("returns content as-is when there are no text blocks", () => {
      const blocks = [
        { type: "image" as const, data: "base64data", mimeType: "image/png" },
      ];

      const result = truncateContentBlocks(blocks);

      expect(mocks.truncateTail).not.toHaveBeenCalled();
      expect(result).toEqual({ content: blocks, truncationDetails: {} });
    });

    it("joins text blocks before truncating", () => {
      mocks.truncateTail.mockReturnValue({
        content: "hello\nworld",
        truncated: false,
      });

      const blocks = [
        { type: "text" as const, text: "hello" },
        { type: "text" as const, text: "world" },
      ];

      const result = truncateContentBlocks(blocks);

      expect(mocks.truncateTail).toHaveBeenCalledWith("hello\nworld");
      expect(result).toEqual({
        content: [{ type: "text", text: "hello\nworld" }],
        truncationDetails: {},
      });
    });

    it("preserves non-text blocks after truncating text", () => {
      mocks.truncateTail.mockReturnValue({
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
