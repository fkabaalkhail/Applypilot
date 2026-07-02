// chrome-extension/src/content/adapters/types.ts
/**
 * Per-site adapter contract. A matched adapter layers optional overrides on the
 * generic pipeline; every hook is advisory (undefined = keep generic behavior).
 */
import type { Classification } from "../fieldMatcher";
import type { FieldSignals } from "../domUtils";
import type { RuntimeControl } from "../formScanner";
import type { ControlType, FieldCategory, UserApplicationProfile } from "../../shared/types";

export interface FieldContext {
  el: HTMLElement;
  signals: FieldSignals;
  controlType: ControlType;
}

export interface AnswerContext {
  category: FieldCategory;
  profile: UserApplicationProfile; // only supplied when a profile is loaded
  control: { controlType: ControlType; options?: string[]; groupIndex?: number | null };
  fillEEO: boolean;
  el: HTMLElement;
}

export interface FillContext {
  control: RuntimeControl;
  value: string;
  el: HTMLElement;
}

export interface AdapterFillResult {
  filled: boolean;
  reason?: string;
}

export interface SiteAdapter {
  id: string;
  /** Detection — pure, host/url only, no DOM. */
  match(host: string, url: string): boolean;
  /** Correct a field's category; undefined keeps the generic Classification. */
  classify?(ctx: FieldContext, generic: Classification): Classification | undefined;
  /** Site-specific value; undefined = generic, string|null = use verbatim. */
  resolveAnswer?(ctx: AnswerContext): string | null | undefined;
  /** undefined (sync) declines → generic fill; a Promise claims + fills the field. */
  fillOperation?(ctx: FillContext): Promise<AdapterFillResult> | undefined;
}
