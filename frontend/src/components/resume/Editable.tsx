import { useLayoutEffect, useRef } from "react";

/**
 * Inline editing primitives for the document canvas.
 *
 * The resume must look like a resume, not like a form, so a field renders as
 * plain text until it's hovered or focused. These are real inputs underneath —
 * not contentEditable — so paste, undo, and screen readers all behave.
 */

interface TextProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
}

export function EditableText({ value, onChange, placeholder, ariaLabel, className = "" }: TextProps) {
  return (
    <input
      type="text"
      className={`rd-edit ${className}`}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** A textarea that grows with its content, so a bullet never scrolls internally. */
export function EditableArea({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className = "",
  rows = 1,
  maxHeight,
}: TextProps & { rows?: number; maxHeight?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const target = maxHeight ? Math.min(el.scrollHeight, maxHeight) : el.scrollHeight;
    el.style.height = `${target}px`;
    el.style.overflowY = maxHeight && el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [value, maxHeight]);

  return (
    <textarea
      ref={ref}
      rows={rows}
      className={`rd-edit ${className}`}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** An editable list of bullets: enter adds, backspace on an empty line removes. */
export function BulletList({
  bullets,
  onChange,
  label,
}: {
  bullets: string[];
  onChange: (bullets: string[]) => void;
  label: string;
}) {
  const setAt = (index: number, text: string) =>
    onChange(bullets.map((b, i) => (i === index ? text : b)));

  const removeAt = (index: number) => onChange(bullets.filter((_, i) => i !== index));

  const insertAfter = (index: number) => {
    const next = [...bullets];
    next.splice(index + 1, 0, "");
    onChange(next);
  };

  return (
    <>
      <ul className="rd-bullets">
        {bullets.map((bullet, i) => (
          <li className="rd-bullet" key={i}>
            <EditableArea
              value={bullet}
              onChange={(text) => setAt(i, text)}
              ariaLabel={`${label} bullet ${i + 1}`}
              placeholder="Describe what you did and what changed because of it…"
            />
            <button
              type="button"
              className="rd-bullet-remove"
              aria-label={`Remove ${label} bullet ${i + 1}`}
              onClick={() => removeAt(i)}
            >
              <i className="fa-solid fa-xmark" />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="rd-add" onClick={() => insertAfter(bullets.length - 1)}>
        <i className="fa-solid fa-plus" /> Add bullet
      </button>
    </>
  );
}

/** Tag-style editing for a flat list of short strings (skills, languages). */
export function ChipList({
  values,
  onChange,
  label,
  placeholder = "Add…",
}: {
  values: string[];
  onChange: (values: string[]) => void;
  label: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  const commit = () => {
    const text = ref.current?.value.trim();
    if (!text) return;
    // One paste of "React, Node, SQL" becomes three chips.
    const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
    onChange([...values, ...parts]);
    if (ref.current) ref.current.value = "";
  };

  return (
    <div className="rd-chips">
      {values.map((value, i) => (
        <span className="rd-chip" key={`${value}-${i}`}>
          {value}
          <button
            type="button"
            aria-label={`Remove ${value} from ${label}`}
            onClick={() => onChange(values.filter((_, j) => j !== i))}
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </span>
      ))}
      <input
        ref={ref}
        type="text"
        className="rd-edit rd-chip-input"
        aria-label={`Add to ${label}`}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}
