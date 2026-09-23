import { describe, expect, it } from "vitest";
import { imageMimeForPath, mediaKindForPath } from "./mediaKind";

describe("mediaKindForPath", () => {
  it("classifies each supported family", () => {
    expect(mediaKindForPath("/repo/logo.png")).toBe("image");
    expect(mediaKindForPath("/repo/clip.mov")).toBe("video");
    expect(mediaKindForPath("/repo/take.flac")).toBe("audio");
    expect(mediaKindForPath("/repo/spec.pdf")).toBe("pdf");
  });

  it("matches extensions case-insensitively", () => {
    expect(mediaKindForPath("/repo/LOGO.PNG")).toBe("image");
    expect(mediaKindForPath("/repo/Clip.MP4")).toBe("video");
  });

  it("returns null for a file with no extension", () => {
    expect(mediaKindForPath("/repo/Makefile")).toBeNull();
  });

  it("treats a dotfile as having no extension", () => {
    expect(mediaKindForPath("/repo/.gitignore")).toBeNull();
    expect(mediaKindForPath("/repo/.png")).toBeNull();
  });

  it("ignores dots in parent directories", () => {
    expect(mediaKindForPath("/repo/v1.2/README")).toBeNull();
    expect(mediaKindForPath("/repo/.github/logo.png")).toBe("image");
  });

  it("handles windows separators", () => {
    expect(mediaKindForPath("C:\\repo\\assets\\logo.webp")).toBe("image");
  });

  it("returns null for a non-media extension", () => {
    expect(mediaKindForPath("/repo/main.rs")).toBeNull();
  });
});

describe("imageMimeForPath", () => {
  it("maps known image extensions", () => {
    expect(imageMimeForPath("/repo/a.png")).toBe("image/png");
    expect(imageMimeForPath("/repo/a.jpg")).toBe("image/jpeg");
    expect(imageMimeForPath("/repo/a.JPEG")).toBe("image/jpeg");
    expect(imageMimeForPath("/repo/a.gif")).toBe("image/gif");
    expect(imageMimeForPath("/repo/a.webp")).toBe("image/webp");
    expect(imageMimeForPath("/repo/a.svg")).toBe("image/svg+xml");
    expect(imageMimeForPath("/repo/a.ico")).toBe("image/x-icon");
  });

  it("falls back to a generic type for anything else", () => {
    expect(imageMimeForPath("/repo/a.mp4")).toBe("application/octet-stream");
    expect(imageMimeForPath("/repo/Makefile")).toBe("application/octet-stream");
  });
});
