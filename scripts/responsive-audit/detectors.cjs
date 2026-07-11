/**
 * In-page layout detectors. Serialized into the browser by audit.cjs.
 *
 * Each detector answers a concrete, falsifiable question about the rendered
 * page — no heuristics about "looks wrong". A finding means: a user on this
 * viewport cannot see or cannot reach something.
 *
 *   page-scrolls-horizontally  the document itself is wider than the viewport
 *   element-off-viewport       an element's box extends past the viewport edge
 *   content-clipped-x/y        an overflow:hidden box is cutting real content off
 *   unreachable-control        a control inside a fixed layer sits past the fold
 *                              with nothing scrollable between it and the layer
 *   overflows-parent-x         an element spills sideways out of its container
 *   small-tap-target           (touch widths only) interactive box under 36px
 */

// NOTE: this function is stringified and evaluated in the page. It must be
// self-contained — no closures over Node scope.
function pageAudit(opts) {
  const TOUCH = opts.touch;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const out = [];
  const EPS = 2;

  const DECOR = /(gradient|mesh|glow|blur|orb|decor|aurora|halo|shine|ring|particle|noise|grid-bg|spotlight|beam|shimmer)/i;

  const sel = (el) => {
    if (!el || el.nodeType !== 1) return "?";
    if (el === document.body) return "body";
    const id = el.id ? "#" + el.id : "";
    let cls = "";
    const cn = el.getAttribute("class");
    if (cn && cn.trim()) cls = "." + cn.trim().split(/\s+/).slice(0, 3).join(".");
    return el.tagName.toLowerCase() + id + cls;
  };
  const chain = (el) => {
    const parts = [];
    let n = el;
    let d = 0;
    while (n && n !== document.body && d < 4) {
      parts.unshift(sel(n));
      n = n.parentElement;
      d++;
    }
    return parts.join(" > ");
  };
  const text = (el) => (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
  const hasRealContent = (el) => {
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (/^(img|svg|canvas|video|input|select|textarea|button|a)$/i.test(el.tagName)) return true;
    return text(el).length > 0;
  };
  const isDecorative = (el) => {
    const cn = el.getAttribute("class") || "";
    return DECOR.test(cn) || el.getAttribute("aria-hidden") === "true";
  };
  const visible = (el, cs) =>
    cs.display !== "none" &&
    cs.visibility !== "hidden" &&
    parseFloat(cs.opacity || "1") > 0.02;

  // A marquee: content deliberately made wider than a clipping wrapper and
  // animated through it (logo strips, tickers). Wide + clipped is the design.
  const inAnimatedTrack = (el) => {
    let n = el;
    let clipped = false;
    let animated = false;
    for (let d = 0; n && n !== document.body && d < 6; d++) {
      const c = getComputedStyle(n);
      if (c.animationName && c.animationName !== "none") animated = true;
      if (c.overflowX === "hidden" || c.overflowX === "clip") clipped = true;
      n = n.parentElement;
    }
    return animated && clipped;
  };

  // …and the clipping wrapper itself is not animated — only its track is — so
  // looking upward from the wrapper never sees the animation. Look down too.
  const isMarqueeWrapper = (el) => {
    for (const c of el.children) {
      const cs = getComputedStyle(c);
      if (cs.animationName && cs.animationName !== "none") return true;
    }
    return false;
  };

  const scrollableAncestor = (el, axis, stopAt) => {
    let n = el.parentElement;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      const ov = axis === "x" ? cs.overflowX : cs.overflowY;
      if (ov === "auto" || ov === "scroll") return n;
      if (stopAt && n === stopAt) return null;
      n = n.parentElement;
    }
    return null;
  };

  const push = (f) => {
    if (out.length < 400) out.push(f);
  };

  /* ---------- 0. did the screen even render? ---------- */
  const bodyText = (document.body.innerText || "").trim();
  if (bodyText.length < 40) {
    push({
      type: "page-blank",
      severity: "high",
      selector: "body",
      chain: "body",
      text: bodyText.slice(0, 40),
      detail: "body rendered " + bodyText.length + " chars of text — the screen did not load (crash, redirect, or bad fixture)",
      overflowPx: 0,
    });
    return out; // nothing else is meaningful
  }

  /* ---------- 1. document-level horizontal overflow ---------- */
  const de = document.documentElement;
  const docSW = Math.max(de.scrollWidth, document.body.scrollWidth);
  if (docSW > vw + EPS) {
    push({
      type: "page-scrolls-horizontally",
      severity: "high",
      selector: "html",
      chain: "html",
      text: "",
      detail: "document scrollWidth " + docSW + "px vs viewport " + vw + "px (+" + (docSW - vw) + ")",
      overflowPx: docSW - vw,
    });
  }

  const all = Array.from(document.body.querySelectorAll("*"));
  const csCache = new Map();
  const cs_ = (el) => {
    let c = csCache.get(el);
    if (!c) {
      c = getComputedStyle(el);
      csCache.set(el, c);
    }
    return c;
  };

  const offViewport = new Set();

  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "link" || tag === "path" || tag === "g" || tag === "defs") continue;
    if (el.ownerSVGElement) continue;

    const cs = cs_(el);
    if (!visible(el, cs)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;

    /* ---------- 2. hard clipping (content cut off, unreachable) ----------
       Two exemptions, both about elements whose scrollWidth does not mean what
       it means on a normal box:
         · form controls — an <input> longer than its box scrolls internally by
           design; that content is not lost.
         · replaced elements — <img>.scrollWidth reports the image's *intrinsic*
           size, so any downscaled image looks "clipped". It is not. */
    const isFormControl = /^(input|textarea|select|option|progress|meter)$/.test(tag);
    const isReplaced = /^(img|picture|video|canvas|iframe|embed|object)$/.test(tag);
    const exemptFromClip =
      isFormControl || isReplaced || inAnimatedTrack(el) || isMarqueeWrapper(el);
    const clipX = !exemptFromClip && (cs.overflowX === "hidden" || cs.overflowX === "clip");
    const clipY = !exemptFromClip && (cs.overflowY === "hidden" || cs.overflowY === "clip");
    const ellipsis = cs.textOverflow === "ellipsis";
    const clamped = cs.webkitLineClamp && cs.webkitLineClamp !== "none";

    if (clipX && !ellipsis && el.scrollWidth > el.clientWidth + 4 && !isDecorative(el)) {
      // find the child actually being cut
      let victim = null;
      for (const c of el.children) {
        const ccs = cs_(c);
        if (!visible(c, ccs) || isDecorative(c)) continue;
        const cr = c.getBoundingClientRect();
        if (cr.right > r.right + 2 && hasRealContent(c)) {
          victim = c;
          break;
        }
      }
      if (victim || hasRealContent(el)) {
        push({
          type: "content-clipped-x",
          severity: "high",
          selector: sel(el),
          chain: chain(el),
          text: text(victim || el),
          detail:
            "overflow-x:" + cs.overflowX + " is cutting " + (el.scrollWidth - el.clientWidth) +
            "px of content" + (victim ? " — hidden child: " + sel(victim) : ""),
          overflowPx: el.scrollWidth - el.clientWidth,
        });
      }
    }

    /* ---------- 2b. clipped at the START edge ----------
       scrollWidth/scrollHeight only grow from overflow past the *end* edges
       (right/bottom in LTR). Content pushed past the TOP or LEFT of a clipping
       box is silently shaved and the scroll metrics never notice — so rules 2
       and 3 are structurally blind to it. Rotated ribbons and absolutely
       positioned badges are the usual victims. Measure the children directly. */
    if ((clipX || clipY) && !isDecorative(el)) {
      for (const c of el.querySelectorAll("*")) {
        const ccs = cs_(c);
        if (!visible(c, ccs) || isDecorative(c) || !hasRealContent(c)) continue;
        if (ccs.position === "fixed") continue;
        // A marquee's items are *supposed* to be shaved at the leading edge as
        // they scroll through the clip. The exemption has to be tested on the
        // victim, not on the clipping box: the animated track is often a
        // grandchild, so the box itself looks perfectly ordinary.
        if (inAnimatedTrack(c)) continue;
        const cr = c.getBoundingClientRect();
        if (cr.width < 2 || cr.height < 2) continue;
        const cutTop = clipY ? r.top - cr.top : 0;
        const cutLeft = clipX ? r.left - cr.left : 0;
        if (cutTop > 2 || cutLeft > 2) {
          push({
            type: "content-clipped-start",
            severity: "high",
            selector: sel(c),
            chain: chain(c),
            text: text(c),
            detail:
              "shaved by " + Math.round(Math.max(cutTop, cutLeft)) + "px at the " +
              (cutTop > cutLeft ? "top" : "left") + " edge of " + sel(el) +
              " (overflow " + cs.overflowX + "/" + cs.overflowY +
              ") — scrollWidth/scrollHeight cannot see start-edge overflow",
            overflowPx: Math.round(Math.max(cutTop, cutLeft)),
          });
          break;
        }
      }
    }

    if (clipY && !clamped && el.scrollHeight > el.clientHeight + 4 && !isDecorative(el)) {
      let victim = null;
      for (const c of el.querySelectorAll("*")) {
        const ccs = cs_(c);
        if (!visible(c, ccs) || isDecorative(c)) continue;
        const cr = c.getBoundingClientRect();
        if (cr.top >= r.bottom - 2 && hasRealContent(c) && cr.height > 4) {
          victim = c;
          break;
        }
      }
      if (victim) {
        push({
          type: "content-clipped-y",
          severity: "high",
          selector: sel(el),
          chain: chain(el),
          text: text(victim),
          detail:
            "overflow-y:" + cs.overflowY + " is cutting " + (el.scrollHeight - el.clientHeight) +
            "px of content — hidden below the box: " + sel(victim),
          overflowPx: el.scrollHeight - el.clientHeight,
        });
      }
    }

    /* ---------- 3. element extends past the viewport edge ---------- */
    const pastRight = r.right > vw + EPS;
    const pastLeft = r.left < -EPS && r.right > 0; // fully-offscreen-left = intentional (sr-only, drawers)
    if ((pastRight || pastLeft) && !isDecorative(el) && !inAnimatedTrack(el)) {
      const scroller = scrollableAncestor(el, "x");
      if (!scroller) {
        const p = el.parentElement;
        const pr = p && p !== document.body ? p.getBoundingClientRect() : null;
        const parentAlsoPast = pr ? pr.right > vw + EPS || pr.left < -EPS : false;
        if (!parentAlsoPast) {
          offViewport.add(el);
          push({
            type: "element-off-viewport",
            severity: "high",
            selector: sel(el),
            chain: chain(el),
            text: text(el),
            detail:
              (pastRight
                ? "right edge at " + Math.round(r.right) + "px, " + Math.round(r.right - vw) + "px past the viewport"
                : "left edge at " + Math.round(r.left) + "px, off the left of the viewport") +
              " (box " + Math.round(r.width) + "×" + Math.round(r.height) + ", position:" + cs.position + ")",
            overflowPx: Math.round(pastRight ? r.right - vw : -r.left),
          });
        }
      }
    }

    /* ---------- 4. spills out of its own container ---------- */
    const parent = el.parentElement;
    if (parent && parent !== document.body && cs.position !== "fixed" && cs.position !== "absolute") {
      const pcs = cs_(parent);
      // A pure inline parent has no meaningful content edge to spill out of —
      // its box wraps around whatever line boxes it produced.
      const inlineParent = pcs.display === "inline";
      if (pcs.overflowX === "visible" && visible(parent, pcs) && !inlineParent && !inAnimatedTrack(el)) {
        const pr = parent.getBoundingClientRect();
        // getBoundingClientRect() is in *visual* pixels (it includes any scale
        // from a transformed/zoomed ancestor); getComputedStyle().paddingRight
        // is in *layout* pixels and is never scaled. Mixing the two invents a
        // spill of padding × (1 − scale) for every child of a scaled, padded
        // box. Convert the padding into the same space as the rect.
        const scaleX = parent.offsetWidth > 0 ? pr.width / parent.offsetWidth : 1;
        const padR = (parseFloat(pcs.paddingRight) || 0) * scaleX;
        const inner = pr.right - padR;
        if (r.right > inner + 4 && r.width <= pr.width && hasRealContent(el) && !isDecorative(el) && !offViewport.has(el)) {
          push({
            type: "overflows-parent-x",
            severity: "medium",
            selector: sel(el),
            chain: chain(el),
            text: text(el),
            detail:
              "spills " + Math.round(r.right - inner) + "px past " + sel(parent) + " (which does not clip or scroll)",
            overflowPx: Math.round(r.right - inner),
          });
        }
      }
    }

    /* ---------- 6. tap targets on touch widths ---------- */
    if (TOUCH) {
      const interactive =
        /^(button|a|input|select|textarea)$/.test(tag) ||
        el.getAttribute("role") === "button" ||
        el.getAttribute("role") === "tab";
      if (interactive && cs.pointerEvents !== "none") {
        const inputType = (el.getAttribute("type") || "").toLowerCase();
        const inline = tag === "a" && cs.display.indexOf("inline") === 0;
        if (!inline && inputType !== "hidden" && (r.width < 36 || r.height < 36)) {
          push({
            type: "small-tap-target",
            severity: "low",
            selector: sel(el),
            chain: chain(el),
            text: text(el),
            detail: Math.round(r.width) + "×" + Math.round(r.height) + "px (minimum comfortable target is 36×36)",
            overflowPx: 0,
          });
        }
      }
    }
  }

  /* ---------- 4b. content stranded above a scroll container's origin ----------
     A scrollable column with `justify-content: center` (or `align-items: center`
     on a row) pushes its overflow out of BOTH ends once the content is taller
     than the box. scrollTop cannot go negative, so everything above the origin
     is unreachable — and the browser does not even count it in scrollHeight, so
     rules 2 and 3 are blind to it. This is a real bug we shipped: the setup
     wizard's first rows of options were unreachable on any screen under ~900px. */
  for (const el of all) {
    const cs = cs_(el);
    if (!visible(el, cs)) continue;
    const scrolls = cs.overflowY === "auto" || cs.overflowY === "scroll";
    if (!scrolls || el.scrollHeight <= el.clientHeight) continue;
    if (el.scrollTop > 1) continue; // already scrolled down; the origin is elsewhere

    const r = el.getBoundingClientRect();
    const top = r.top + (parseFloat(cs.borderTopWidth) || 0);
    let worst = null;
    for (const c of el.children) {
      const ccs = cs_(c);
      if (!visible(c, ccs) || isDecorative(c) || !hasRealContent(c)) continue;
      if (ccs.position === "absolute" || ccs.position === "fixed" || ccs.position === "sticky") continue;
      const cr = c.getBoundingClientRect();
      if (cr.height < 2) continue;
      const above = top - cr.top;
      if (above > 2 && (!worst || above > worst.above)) worst = { el: c, above };
    }
    if (worst) {
      push({
        type: "unreachable-above-scroll-origin",
        severity: "high",
        selector: sel(worst.el),
        chain: chain(worst.el),
        text: text(worst.el),
        detail:
          Math.round(worst.above) + "px of content sits above the top of " + sel(el) +
          " while it is scrolled to the origin (justify-content:" + cs.justifyContent +
          ") — scrollTop cannot go negative, so the user can never reach it",
        overflowPx: Math.round(worst.above),
      });
    }
  }

  /* ---------- 5. unreachable controls inside fixed / sticky layers ---------- */
  const fixedRoots = all.filter((el) => {
    const cs = cs_(el);
    if (cs.position !== "fixed") return false;
    if (!visible(el, cs)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 40;
  });

  for (const root of fixedRoots) {
    const rr = root.getBoundingClientRect();
    // Does anything between a control and this fixed root scroll?
    const controls = root.querySelectorAll(
      "button, a[href], input, select, textarea, [role='button'], [role='tab']"
    );
    let worst = null;
    for (const c of controls) {
      const ccs = cs_(c);
      if (!visible(c, ccs)) continue;
      const cr = c.getBoundingClientRect();
      if (cr.height < 2) continue;
      const belowFold = cr.bottom > vh + EPS;
      const pastRight = cr.right > vw + EPS;
      if (!belowFold && !pastRight) continue;
      const sy = scrollableAncestor(c, "y", root);
      const sx = scrollableAncestor(c, "x", root);
      const rootScrolls =
        cs_(root).overflowY === "auto" || cs_(root).overflowY === "scroll" ||
        cs_(root).overflowX === "auto" || cs_(root).overflowX === "scroll";
      if (belowFold && !sy && !rootScrolls) {
        if (!worst || cr.bottom > worst.rect.bottom) worst = { el: c, rect: cr, axis: "y" };
      } else if (pastRight && !sx && !rootScrolls) {
        if (!worst || cr.right > worst.rect.right) worst = { el: c, rect: cr, axis: "x" };
      }
    }
    if (worst) {
      push({
        type: "unreachable-control",
        severity: "high",
        selector: sel(worst.el),
        chain: chain(worst.el),
        text: text(worst.el),
        detail:
          "inside fixed layer " + sel(root) + " (" + Math.round(rr.width) + "×" + Math.round(rr.height) +
          "); control sits at " + (worst.axis === "y"
            ? "y=" + Math.round(worst.rect.bottom) + " below the " + vh + "px fold"
            : "x=" + Math.round(worst.rect.right) + " past the " + vw + "px edge") +
          " and nothing between it and the layer scrolls",
        overflowPx: Math.round(
          worst.axis === "y" ? worst.rect.bottom - vh : worst.rect.right - vw
        ),
      });
    }
  }

  // De-duplicate: same type + chain
  const seen = new Set();
  const dedup = [];
  for (const f of out) {
    const k = f.type + "|" + f.chain + "|" + f.text;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(f);
  }
  return dedup;
}

module.exports = { pageAudit };
