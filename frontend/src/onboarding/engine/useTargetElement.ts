import { useEffect, useRef, useState } from "react";

type Status = "pending" | "found" | "missing" | "none";

export function useTargetElement(
  selector: string | undefined,
  active: boolean,
  timeoutMs = 2000,
): { rect: DOMRect | null; status: Status } {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [status, setStatus] = useState<Status>("pending");
  const scrolledRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    if (!selector) {
      setStatus("none");
      setRect(null);
      return;
    }

    scrolledRef.current = false;
    let raf = 0;
    let cancelled = false;
    const start = performance.now();
    let el: Element | null = null;

    const measure = () => {
      if (el) setRect(el.getBoundingClientRect());
    };

    const poll = () => {
      if (cancelled) return;
      el = document.querySelector(selector);
      if (el) {
        setStatus("found");
        if (!scrolledRef.current) {
          scrolledRef.current = true;
          el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
        }
        measure();
        return;
      }
      if (performance.now() - start > timeoutMs) {
        setStatus("missing");
        return;
      }
      raf = requestAnimationFrame(poll);
    };

    poll();

    const onChange = () => measure();
    window.addEventListener("scroll", onChange, true);
    window.addEventListener("resize", onChange);
    let ro: ResizeObserver | null = null;
    const roTimer = window.setTimeout(() => {
      if (el && "ResizeObserver" in window) {
        ro = new ResizeObserver(onChange);
        ro.observe(el);
      }
    }, 50);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(roTimer);
      window.removeEventListener("scroll", onChange, true);
      window.removeEventListener("resize", onChange);
      ro?.disconnect();
    };
  }, [selector, active, timeoutMs]);

  return { rect, status };
}
