/**
 * schema/applicant-profile.schema.json is the published contract for the data
 * the extension autofills from. It is hand-written, so it can silently drift
 * from src/shared/types.ts, these tests make that drift a build failure.
 *
 * The validator here is deliberately tiny (types, required, additionalProperties,
 * $ref) rather than a full JSON Schema engine: enough to prove the sample data
 * conforms, with no new dependency.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MOCK_PROFILE } from "../src/api/mockProfile";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const schema = JSON.parse(read("../schema/applicant-profile.schema.json"));
const typesSrc = read("../src/shared/types.ts");

// ---------------------------------------------------------------------------
// Minimal validator
// ---------------------------------------------------------------------------

type Node = Record<string, unknown>;

function resolve(node: Node): Node {
  const ref = node.$ref as string | undefined;
  if (!ref) return node;
  // Only local "#/$defs/name" pointers are used by this schema.
  const name = ref.replace("#/$defs/", "");
  return (schema.$defs as Record<string, Node>)[name];
}

/** Returns the list of violations; empty means valid. */
function validate(value: unknown, node: Node, path = "$"): string[] {
  const s = resolve(node);
  const errors: string[] = [];
  if (s.type === "array") {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    value.forEach((v, i) => errors.push(...validate(v, s.items as Node, `${path}[${i}]`)));
    return errors;
  }
  if (s.type === "string") {
    if (typeof value !== "string") errors.push(`${path}: expected string, got ${typeof value}`);
    return errors;
  }
  if (s.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [`${path}: expected object`];
    }
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Node>;
    for (const req of (s.required ?? []) as string[]) {
      if (!(req in obj)) errors.push(`${path}.${req}: required but missing`);
    }
    for (const [key, v] of Object.entries(obj)) {
      if (!props[key]) {
        if (s.additionalProperties === false) errors.push(`${path}.${key}: not allowed by the schema`);
        continue;
      }
      errors.push(...validate(v, props[key], `${path}.${key}`));
    }
    return errors;
  }
  return errors;
}

// ---------------------------------------------------------------------------
// TypeScript interface reader: key names + which ones are optional
// ---------------------------------------------------------------------------

function interfaceKeys(name: string): { all: string[]; required: string[] } {
  const start = typesSrc.indexOf(`export interface ${name} {`);
  expect(start, `interface ${name} found in types.ts`).toBeGreaterThan(-1);
  const body = typesSrc.slice(start, typesSrc.indexOf("\n}", start));
  const all: string[] = [];
  const required: string[] = [];
  for (const line of body.split("\n").slice(1)) {
    const m = /^\s{2}(\w+)(\??):/.exec(line); // two-space indent = a top-level member
    if (!m) continue;
    all.push(m[1]);
    if (!m[2]) required.push(m[1]);
  }
  return { all, required };
}

// ---------------------------------------------------------------------------

describe("the published profile schema matches the TypeScript type", () => {
  const cases: [string, string, Node][] = [
    ["UserApplicationProfile", "$", schema as Node],
    ["EducationEntry", "$defs.educationEntry", schema.$defs.educationEntry],
    ["ExperienceEntry", "$defs.experienceEntry", schema.$defs.experienceEntry],
    ["EeoAnswers", "$defs.eeoAnswers", schema.$defs.eeoAnswers],
  ];

  for (const [tsName, where, node] of cases) {
    it(`${where} declares exactly the fields of ${tsName}`, () => {
      const ts = interfaceKeys(tsName);
      expect(Object.keys(node.properties as object).sort()).toEqual([...ts.all].sort());
    });

    it(`${where} marks the same fields required as ${tsName}`, () => {
      const ts = interfaceKeys(tsName);
      expect([...((node.required as string[]) ?? [])].sort()).toEqual([...ts.required].sort());
    });
  }
});

describe("the schema accepts real profiles", () => {
  it("validates the sample profile the extension ships with", () => {
    expect(validate(MOCK_PROFILE, schema as Node)).toEqual([]);
  });

  it("validates a brand-new, entirely blank profile", () => {
    // Every string field is required-but-may-be-empty: a user who has filled in
    // nothing yet must still produce a schema-valid document.
    const blank = Object.fromEntries(
      (schema.required as string[]).map((k) => [
        k,
        ["education", "experience", "skills"].includes(k) ? [] : "",
      ])
    );
    expect(validate(blank, schema as Node)).toEqual([]);
  });
});

describe("the schema rejects malformed profiles", () => {
  it("rejects a missing required field", () => {
    const { firstName: _drop, ...rest } = MOCK_PROFILE as unknown as Record<string, unknown>;
    expect(validate(rest, schema as Node)).toContain("$.firstName: required but missing");
  });

  it("rejects an unknown top-level field, so typos surface instead of silently no-op'ing", () => {
    const errors = validate({ ...MOCK_PROFILE, phoneNumber: "555" }, schema as Node);
    expect(errors).toContain("$.phoneNumber: not allowed by the schema");
  });

  it("rejects a graduation year sent as a number instead of a string", () => {
    const bad = { ...MOCK_PROFILE, education: [{ school: "U", degree: "BSc", graduationYear: 2026 }] };
    expect(validate(bad, schema as Node)).toContain("$.education[0].graduationYear: expected string, got number");
  });
});
