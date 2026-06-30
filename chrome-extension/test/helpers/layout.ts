/**
 * jsdom has no layout engine, so getClientRects() returns an empty list and the
 * scanner's isVisible() rejects every control. Pretend each element occupies a
 * box so visibility-gated discovery runs the way it does in a real browser. Call
 * the returned function in afterAll to restore the original behavior.
 */
export function stubLayout(): () => void {
  const proto = window.HTMLElement.prototype;
  const original = proto.getClientRects;
  proto.getClientRects = function (): DOMRectList {
    return [{ width: 100, height: 20 }] as unknown as DOMRectList;
  };
  return () => {
    proto.getClientRects = original;
  };
}
