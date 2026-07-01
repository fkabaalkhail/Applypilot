/**
 * Shared contract between the isolated-world client (mainWorldClient.ts) and the
 * MAIN-world driver (mainWorld.ts). Kept dependency-free so both worlds bundle it
 * without pulling in isolated-only code, and so the two sides can never drift.
 */
export type FillDriver = "react-select" | "workday";

/** Isolated → MAIN: please fill this field. */
export const MW_FILL_EVENT = "tailrd:mw:fill";
/** MAIN → isolated: here is the outcome. */
export const MW_RESULT_EVENT = "tailrd:mw:result";

export interface MwFillDetail {
  id: number;
  /** Value of FIELD_ID_ATTR on the target node (locates it in the MAIN world). */
  fieldId: string;
  value: string;
  kind: FillDriver;
}

export interface MwResultDetail {
  id: number;
  ok: boolean;
  /** The widget's committed/displayed value after the fill, if readable. */
  committed?: string;
  reason?: string;
}
