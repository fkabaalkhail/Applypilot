/**
 * The "Autofilling" waves that slide open under the primary button while a
 * fill runs, pushing "Your Autofill Information" and the sections below it
 * down to make the room.
 *
 * Two invariants here are easy to break by touching only one side:
 *  - the waves must be inline <svg>, because a strict img-src CSP (Greenhouse,
 *    Workday) blocks the data-URI backgrounds they would otherwise be;
 *  - the drift shift, the <svg> width and the gradient period must agree, or
 *    the loop visibly pops once a cycle.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { STYLES, buildHTML, installRefs, renderFillWave, waveLayerHTML } from "../src/content/overlay";

function mountPanel(): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "ap-root";
  root.innerHTML = buildHTML();
  document.body.append(root);
  installRefs(root);
  return root;
}

const wave = (root: HTMLElement) => root.querySelector<HTMLDivElement>("#ap-fillwave")!;

beforeEach(() => { document.body.innerHTML = ""; });

describe("wave block markup", () => {
  it("renders collapsed and out of the a11y tree before any fill runs", () => {
    const el = wave(mountPanel());
    expect(el.classList.contains("is-active")).toBe(false);
    expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  it("labels itself Autofilling, announced as a status", () => {
    const label = wave(mountPanel()).querySelector(".ap-fillwave-label")!;
    expect(label.textContent).toBe("Autofilling");
    expect(label.getAttribute("role")).toBe("status");
  });

  it("sits directly above Your Autofill Information, so that section and the ones below it are what move", () => {
    const root = mountPanel();
    const next = wave(root).nextElementSibling!;
    expect(next.querySelector(".ap-section-title")?.textContent).toBe("Your Autofill Information");
  });

  it("draws two waves as inline <svg>, never a data-URI background a strict img-src CSP would block", () => {
    const stage = wave(mountPanel()).querySelector(".ap-fillwave-stage")!;
    expect(stage.querySelectorAll(".ap-wave-layer > svg").length).toBe(2);
    expect(stage.querySelector(".ap-wave-back")).not.toBeNull();
    expect(stage.querySelector(".ap-wave-front")).not.toBeNull();
    expect(stage.innerHTML).not.toMatch(/url\(\s*['"]?data:/);
  });

  it("gives each wave its own gradient and points its path at it", () => {
    const stage = mountPanel().querySelector(".ap-fillwave-stage")!;
    const ids = [...stage.querySelectorAll("linearGradient")].map((g) => g.getAttribute("id"));
    expect(new Set(ids).size).toBe(2);
    for (const layer of stage.querySelectorAll(".ap-wave-layer")) {
      const id = layer.querySelector("linearGradient")!.getAttribute("id");
      expect(layer.querySelector("path")!.getAttribute("fill")).toBe(`url(#${id})`);
    }
  });

  it("draws the two waves half a period out of phase", () => {
    const d = (which: "back" | "front") => {
      const el = document.createElement("div");
      el.innerHTML = waveLayerHTML(which);
      return el.querySelector("path")!.getAttribute("d")!;
    };
    expect(d("back")).not.toBe(d("front"));
    // Both leave the same y=16 baseline; the back one pulls its first control
    // point up and the front one down (SVG y grows downward), so one crests
    // exactly where the other troughs.
    const firstControlY = (path: string) => Number(/^M0 16C[\d.]+ ([\d.]+)/.exec(path)![1]);
    expect(firstControlY(d("back"))).toBeLessThan(16);
    expect(firstControlY(d("front"))).toBeGreaterThan(16);
  });
});

describe("renderFillWave", () => {
  it("raises and lowers the waves", () => {
    const el = wave(mountPanel());

    renderFillWave(true);
    expect(el.classList.contains("is-active")).toBe(true);
    expect(el.getAttribute("aria-hidden")).toBe("false");

    renderFillWave(false);
    expect(el.classList.contains("is-active")).toBe(false);
    expect(el.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("styles", () => {
  it("collapses to nothing and opens to the inner block's own height", () => {
    expect(STYLES).toMatch(/\.ap-fillwave\s*\{[^}]*height:\s*0;/);
    expect(STYLES).toMatch(/\.ap-fillwave\.is-active\s*\{[^}]*height:\s*116px;/);
    expect(STYLES).toMatch(/\.ap-fillwave-inner\s*\{[^}]*height:\s*116px;/);
  });

  it("loops seamlessly: two periods across the viewBox, 200% wide, shifted by one", () => {
    // 240-unit viewBox / 2 periods = a 120-unit period, which is half of a
    // 200%-wide <svg>. Change any one of these three and the wave pops.
    expect(waveLayerHTML("front")).toContain('viewBox="0 0 240 40"');
    expect(waveLayerHTML("front")).toContain('x2="120"');
    expect(waveLayerHTML("front")).toContain('spreadMethod="repeat"');
    expect(STYLES).toMatch(/\.ap-wave-layer svg\s*\{[^}]*width:\s*200%;/);
    // @keyframes nests braces, so this cannot be [^}]-bounded like the rules.
    expect(STYLES).toMatch(/@keyframes ap-wave-drift[\s\S]{0,200}?translateX\(-50%\)/);
  });

  it("tiles the gradient: first and last stop share a hue", () => {
    for (const which of ["back", "front"] as const) {
      const stops = [...waveLayerHTML(which).matchAll(/stop-color="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
      expect(stops.length).toBeGreaterThan(2);
      expect(stops[0]).toBe(stops[stops.length - 1]);
    }
  });

  it("honours prefers-reduced-motion", () => {
    expect(STYLES).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none/);
  });

  it("gives the primary button the Continue gate's rectangular corner", () => {
    // [^}] keeps this inside the rule; unbounded, it would run on into later
    // rules and read their corners as this button's.
    expect(STYLES).toMatch(/\.ap-btn-autofill\s*\{[^}]*border-radius:\s*8px;/);
    expect(STYLES).not.toMatch(/\.ap-btn-autofill\s*\{[^}]*border-radius:\s*9999px;/);
  });
});

describe("primary button label", () => {
  it("reads Autofill", () => {
    const btn = mountPanel().querySelector("#ap-btn-autofill")!;
    expect(btn.textContent).toBe("Autofill");
  });
});
