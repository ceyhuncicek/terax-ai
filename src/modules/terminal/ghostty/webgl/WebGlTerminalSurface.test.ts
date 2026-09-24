import { IS_MAC } from "@/lib/platform";
import type { TerminalLinkTarget } from "@/modules/terminal/ghostty/core/terminalLinks";
import type { GhosttyTerminalModelApi } from "@/modules/terminal/ghostty/GhosttyTerminalModel";
import type { WindowPresentation } from "@/modules/terminal/ghostty/WindowPresentationPolicy";
import type { WebGlCellRenderer } from "@/modules/terminal/ghostty/webgl/WebGlCellRenderer";
import { WebGlTerminalSurface } from "@/modules/terminal/ghostty/webgl/WebGlTerminalSurface";
import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  runtime: {} as unknown,
  visibility: (_state: WindowPresentation) => {},
}));
vi.mock("@/modules/terminal/ghostty/webgl/WebGlTerminalRuntime", () => ({
  getWebGlTerminalRuntime: () => bridge.runtime,
}));
vi.mock("@/modules/terminal/ghostty/windowPresentation", () => ({
  terminalWindowPresentation: () => ({ visible: true, reclaim: false }),
  subscribeWindowPresentation: (listener: typeof bridge.visibility) => {
    bridge.visibility = listener;
    return () => {};
  },
}));

const surfaces: WebGlTerminalSurface[] = [];
afterEach(() => {
  for (const surface of surfaces.splice(0)) surface.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WebGL surface renderer ownership", () => {
  it.each(["theme", "font", "resume", "dpr"] as const)(
    "clears disposed renderer ownership when %s reconfiguration and recovery both fail",
    (trigger) => {
      const h = harness();
      h.acquire.mockImplementation(() => {
        throw new Error("configure failed");
      });
      const calls = h.renderer.resize.mock.calls.length;
      h.trigger(trigger);
      expect(h.onError).toHaveBeenCalledOnce();
      expect(h.surface.diagnostics().renderer).toBeNull();
      expect(h.renderer.resize).toHaveBeenCalledTimes(calls);
      h.surface.setFontMetrics({ ...METRICS, cellWidth: 10 });
      h.resize();
      expect(
        h.surface.renderFrame(h.renderer as unknown as WebGlCellRenderer),
      ).toBe(false);
      expect(h.renderer.resize).toHaveBeenCalledTimes(calls);
      expect(h.renderer.resetModel).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("replaces a failed renderer once while retaining model and selection", () => {
    const h = harness();
    const replacement = renderer();
    h.acquire.mockImplementationOnce(() => {
      throw new Error("configure failed");
    });
    h.acquire.mockReturnValue(replacement);
    h.trigger("font");
    expect(h.surface.diagnostics().rendererRecoveries).toBe(1);
    expect(h.surface.getSelection()).toBe("selected output");
    expect(h.renderer.resetModel).not.toHaveBeenCalled();
    expect(replacement.resize).toHaveBeenCalledOnce();
    expect(replacement.resetModel).toHaveBeenCalledOnce();
    expect(
      h.surface.renderFrame(replacement as unknown as WebGlCellRenderer),
    ).toBe(true);
    expect(h.onError).not.toHaveBeenCalled();
  });
});

// clientX 44 / clientY 56 lands on viewport cell row 3, column 5 at 8x16 cells.
describe("WebGL surface link activation", () => {
  it("opens the hovered link on a modifier click", () => {
    const h = harness();
    h.setLink(0, 3, 5, DOCS);
    h.pointer("pointerdown", { clientX: 44, clientY: 56, ...MODIFIER });
    h.pointer("pointerup", { clientX: 45, clientY: 57, ...MODIFIER });
    expect(h.onOpenLink).toHaveBeenCalledWith(DOCS);
  });

  it("re-resolves the link after a scroll that does not change the revision", () => {
    const h = harness();
    h.setLink(0, 3, 5, DOCS);
    h.setLink(7, 3, 5, CHANGELOG);
    h.pointer("pointermove", { clientX: 44, clientY: 56, ...MODIFIER });
    h.scrollTo(7);
    h.pointer("pointerdown", { clientX: 44, clientY: 56, ...MODIFIER });
    h.pointer("pointerup", { clientX: 44, clientY: 56, ...MODIFIER });
    expect(h.onOpenLink).toHaveBeenCalledWith(CHANGELOG);
    expect(h.onOpenLink).not.toHaveBeenCalledWith(DOCS);
  });

  it("keeps an in-flight click alive across terminal output", () => {
    const h = harness();
    h.setLink(0, 3, 5, DOCS);
    h.pointer("pointerdown", { clientX: 44, clientY: 56, ...MODIFIER });
    h.write();
    h.render();
    h.pointer("pointerup", { clientX: 44, clientY: 56, ...MODIFIER });
    expect(h.onOpenLink).toHaveBeenCalledWith(DOCS);
  });

  it("drops an in-flight click when the pointer is cancelled", () => {
    const h = harness();
    h.setLink(0, 3, 5, DOCS);
    h.pointer("pointerdown", { clientX: 44, clientY: 56, ...MODIFIER });
    h.pointer("pointercancel", { clientX: 44, clientY: 56, ...MODIFIER });
    h.pointer("pointerup", { clientX: 44, clientY: 56, ...MODIFIER });
    expect(h.onOpenLink).not.toHaveBeenCalled();
  });

  it("survives a pointerup from an unrelated pointer", () => {
    const h = harness();
    h.setLink(0, 3, 5, DOCS);
    h.pointer("pointerdown", { clientX: 44, clientY: 56, ...MODIFIER });
    h.pointer("pointerup", {
      pointerId: 2,
      clientX: 44,
      clientY: 56,
      ...MODIFIER,
    });
    h.pointer("pointerup", { clientX: 44, clientY: 56, ...MODIFIER });
    expect(h.onOpenLink).toHaveBeenCalledWith(DOCS);
  });

  it("does not open a link on a plain click", () => {
    const h = harness();
    h.setLink(0, 3, 5, DOCS);
    h.pointer("pointerdown", { clientX: 44, clientY: 56 });
    h.pointer("pointerup", { clientX: 44, clientY: 56 });
    expect(h.onOpenLink).not.toHaveBeenCalled();
  });

  it("does not open a link released outside the grid", () => {
    const h = harness();
    h.setLink(0, 3, 5, DOCS);
    h.pointer("pointerdown", { clientX: 44, clientY: 56, ...MODIFIER });
    h.pointer("pointerup", { clientX: 44, clientY: 900, ...MODIFIER });
    expect(h.onOpenLink).not.toHaveBeenCalled();
  });
});

const METRICS = {
  font: {
    family: "monospace",
    size: 14,
    lineHeight: 1.2,
    letterSpacing: 0,
    weight: "400",
  },
  cellWidth: 8,
  cellHeight: 16,
  baseline: 12,
};
const THEME = {
  background: [0, 0, 0],
  foreground: [255, 255, 255],
  cursor: [255, 255, 255],
  selection: { color: [50, 50, 50], alpha: 0.5 },
  palette: [],
} as const;

const DOCS: TerminalLinkTarget = { kind: "url", url: "https://terax.dev/docs" };
const CHANGELOG: TerminalLinkTarget = {
  kind: "url",
  url: "https://terax.dev/changelog",
};
/** Cmd on macOS, Ctrl elsewhere — the surface reads the real platform. */
const MODIFIER = IS_MAC
  ? { metaKey: true, ctrlKey: false }
  : { metaKey: false, ctrlKey: true };

function pointerEvent(type: string, init: Record<string, unknown>): Event {
  return Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1,
    button: 0,
    buttons: 1,
    detail: 1,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  });
}

function renderer() {
  return {
    resize: vi.fn(() => false),
    resetModel: vi.fn(),
    render: vi.fn(() => true),
    diagnostics: vi.fn(() => ({})),
    requestPresentation: vi.fn(),
    hasBlinkingCells: false,
  };
}

function harness() {
  vi.useFakeTimers();
  const element = () =>
    Object.assign(new EventTarget(), {
      style: { setProperty: vi.fn() },
      scrollTop: 0,
      setAttribute: vi.fn(),
      getAttribute: vi.fn(),
      append: vi.fn(),
      appendChild: vi.fn(),
      remove: vi.fn(),
      focus: vi.fn(),
      contains: () => false,
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn(),
      getBoundingClientRect: () => ({
        width: 960,
        height: 640,
        left: 0,
        top: 0,
        right: 960,
        bottom: 640,
      }),
    });
  const media = new EventTarget();
  vi.stubGlobal("Node", EventTarget);
  vi.stubGlobal("document", { createElement: element });
  vi.stubGlobal("window", {
    devicePixelRatio: 1,
    setTimeout,
    clearTimeout,
    matchMedia: () => media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  let resize = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: (entries: ResizeObserverEntry[]) => void) {
        resize = () => callback([]);
      }
      observe() {}
      disconnect() {}
    },
  );
  const current = renderer();
  const acquire = vi.fn(() => current);
  bridge.runtime = {
    acquire,
    release: vi.fn(),
    discard: vi.fn(),
    schedule: vi.fn(),
    interact: vi.fn(),
    trimForHiddenDocument: vi.fn(),
  };
  const content = { origin: 0, revision: 0 };
  const links = new Map<string, TerminalLinkTarget>();
  const model = {
    cols: 120,
    rows: 40,
    setCursorOptions: vi.fn(),
    revision: () => content.revision,
    linkAtViewportCell: vi.fn(
      (row: number, column: number) =>
        links.get(`${content.origin}:${row}:${column}`) ?? null,
    ),
    bufferLineAtViewportRow: (row: number) => content.origin + row,
    wordRangeAt: () => ({ start: 0, end: 0 }),
    lineEndColumn: () => 0,
    setSelection: vi.fn(),
    subscribeDamage: () => () => {},
    trackedSelection: () => ({
      anchor: { line: 0, column: 0 },
      focus: { line: 0, column: 10 },
      rectangular: false,
    }),
    selectionText: () => "selected output",
    scrollPosition: () => ({ history: 0, offset: 0 }),
    viewportOriginLine: () => content.origin,
    modes: () => ({ alternateScreen: false }),
    setPixelSize: vi.fn(),
    resize: (cols: number, rows: number) => {
      model.cols = cols;
      model.rows = rows;
    },
    cursor: () => ({ x: 0, y: 0, visible: true, blinking: false }),
    deferPresentation: () => false,
    consumeDamage: () => ({ kind: "none" }),
  };
  const onError = vi.fn();
  const onOpenLink = vi.fn();
  const surface = new WebGlTerminalSurface({
    model: model as unknown as GhosttyTerminalModelApi,
    metrics: METRICS,
    theme: THEME,
    cursorBlink: false,
    cursorStyle: "block",
    onResize: vi.fn(),
    onError,
    onOpenLink,
    onRequestFocus: vi.fn(),
  });
  surfaces.push(surface);
  surface.attach(element() as unknown as HTMLElement);
  return {
    surface,
    renderer: current,
    acquire,
    onError,
    onOpenLink,
    model,
    resize: () => resize(),
    /** Places a link at a viewport cell as seen from one scroll origin. */
    setLink(
      origin: number,
      row: number,
      column: number,
      target: TerminalLinkTarget,
    ) {
      links.set(`${origin}:${row}:${column}`, target);
    },
    /** Scrolls the viewport the way the wheel does: no revision bump. */
    scrollTo: (origin: number) => {
      content.origin = origin;
    },
    write: () => {
      content.revision += 1;
    },
    render: () => surface.renderFrame(current as unknown as WebGlCellRenderer),
    pointer: (type: string, init: Record<string, unknown>) =>
      surface.eventTarget().dispatchEvent(pointerEvent(type, init)),
    trigger(trigger: "theme" | "font" | "resume" | "dpr") {
      if (trigger === "theme")
        surface.setTheme({ ...THEME, background: [1, 2, 3] });
      if (trigger === "font")
        surface.setFontMetrics({ ...METRICS, cellWidth: 9 });
      if (trigger === "resume") {
        bridge.visibility({ visible: false, reclaim: false });
        bridge.visibility({ visible: true, reclaim: false });
      }
      if (trigger === "dpr") {
        window.devicePixelRatio = 2;
        media.dispatchEvent(new Event("change"));
      }
    },
  };
}
