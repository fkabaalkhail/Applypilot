import { describe, it, expect, beforeEach } from "vitest";
import { composedAncestors, isInPageChrome } from "../src/content/pageChrome";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("composedAncestors", () => {
  it("walks plain ancestors nearest-first up to <html>", () => {
    document.body.innerHTML = `<div id="a"><div id="b"><input id="x" /></div></div>`;
    const chain = composedAncestors(document.getElementById("x")!);
    const ids = chain.map((e) => e.id || e.tagName);
    expect(ids).toEqual(["b", "a", "BODY", "HTML"]);
  });

  it("crosses an open shadow-root boundary via the host", () => {
    document.body.innerHTML = `<header id="hdr"><div id="host"></div></header>`;
    const host = document.getElementById("host")!;
    const root = host.attachShadow({ mode: "open" });
    const inner = document.createElement("input");
    root.appendChild(inner);
    const chain = composedAncestors(inner);
    expect(chain).toContain(host);
    expect(chain).toContain(document.getElementById("hdr"));
  });
});

describe("isInPageChrome", () => {
  it("flags controls inside header / nav / footer / aside", () => {
    document.body.innerHTML = `
      <header><select id="lang"><option>EN</option><option>FR</option></select></header>
      <nav><input id="n" /></nav>
      <footer><input id="f" type="email" /></footer>
      <aside><input id="s" /></aside>`;
    for (const id of ["lang", "n", "f", "s"]) {
      expect(isInPageChrome(document.getElementById(id)!)).toBe(true);
    }
  });

  it("flags landmark roles (navigation, banner, contentinfo, search, complementary)", () => {
    document.body.innerHTML = `
      <div role="navigation"><input id="a" /></div>
      <div role="banner"><input id="b" /></div>
      <div role="contentinfo"><input id="c" /></div>
      <form role="search"><input id="d" /></form>
      <div role="complementary"><input id="e" /></div>`;
    for (const id of ["a", "b", "c", "d", "e"]) {
      expect(isInPageChrome(document.getElementById(id)!)).toBe(true);
    }
  });

  it("flags a shadow-hosted control whose host sits inside chrome", () => {
    document.body.innerHTML = `<nav id="nav"><div id="host"></div></nav>`;
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    root.appendChild(input);
    expect(isInPageChrome(input)).toBe(true);
  });

  it("does NOT flag an ordinary application-form field", () => {
    document.body.innerHTML = `<main><form><input id="first" name="first_name" /></form></main>`;
    expect(isInPageChrome(document.getElementById("first")!)).toBe(false);
  });
});
