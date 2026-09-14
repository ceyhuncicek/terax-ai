import { describe, expect, it } from "vitest";
import { hasClipboardImage } from "./clipboardImage";

function transfer(init: {
  types?: string[];
  items?: { kind: string; type: string }[];
  files?: { type: string }[];
}): DataTransfer {
  return {
    types: init.types ?? [],
    items: init.items ?? [],
    files: init.files ?? [],
  } as unknown as DataTransfer;
}

describe("hasClipboardImage", () => {
  it("detects an image-only clipboard advertised through types", () => {
    expect(hasClipboardImage(transfer({ types: ["image/png"] }))).toBe(true);
  });

  it("detects an image file when only items are populated", () => {
    expect(
      hasClipboardImage(
        transfer({
          types: ["Files"],
          items: [{ kind: "file", type: "image/jpeg" }],
        }),
      ),
    ).toBe(true);
  });

  it("detects an image through the file list alone", () => {
    expect(
      hasClipboardImage(transfer({ files: [{ type: "IMAGE/TIFF" }] })),
    ).toBe(true);
  });

  it("ignores a text-only clipboard so plain pastes skip the IPC round trip", () => {
    expect(
      hasClipboardImage(transfer({ types: ["text/plain", "text/html"] })),
    ).toBe(false);
  });

  it("ignores a non-image file drop", () => {
    expect(
      hasClipboardImage(
        transfer({
          types: ["Files"],
          items: [{ kind: "file", type: "application/pdf" }],
          files: [{ type: "application/pdf" }],
        }),
      ),
    ).toBe(false);
  });

  it("treats a missing clipboard payload as no image", () => {
    expect(hasClipboardImage(null)).toBe(false);
    expect(hasClipboardImage(undefined)).toBe(false);
  });
});
