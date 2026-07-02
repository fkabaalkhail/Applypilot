// chrome-extension/src/content/adapters/index.ts
// Importing the adapter modules registers them (ADAPTERS.push at import time).
import "./greenhouse";
import "./workday";
export { getAdapter, resolveAdapter, ADAPTERS } from "./registry";
export type { SiteAdapter, FieldContext, AnswerContext, FillContext, AdapterFillResult } from "./types";
export {
  classifyWithAdapter,
  resolveAnswerWithAdapter,
  tryAdapterOperation,
  runAdapterOperations,
} from "./apply";
