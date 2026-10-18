import type { Check } from "../cases/current";

const isoLike = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v);

/** Deep equality; ISO timestamps compare by instant so +08:00 and Z forms are equal. */
export function same(a: unknown, b: unknown): boolean {
  if (isoLike(a) && isoLike(b)) return Date.parse(a) === Date.parse(b);
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort(),
      kb = Object.keys(b as object).sort();
    return (
      same(ka, kb) &&
      ka.every((k) =>
        same(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
      )
    );
  }
  return a === b;
}

/** Reads `a.b.c`; a `*` segment maps over an array (`tags.*.value`). */
export function readPath(value: unknown, path: string): unknown {
  const [head, ...rest] = path.split(".");
  if (head === undefined || head === "") return value;
  if (head === "*")
    return Array.isArray(value)
      ? value.map((v) => readPath(v, rest.join(".")))
      : undefined;
  const next =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)[head]
      : undefined;
  return rest.length ? readPath(next, rest.join(".")) : next;
}

const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === "" ||
  (Array.isArray(v) && v.length === 0);
const contains = (haystack: unknown, needle: unknown) =>
  Array.isArray(haystack)
    ? haystack.some(
        (el) =>
          same(el, needle) ||
          (typeof el === "string" &&
            typeof needle === "string" &&
            el.includes(needle)),
      )
    : typeof haystack === "string" &&
      typeof needle === "string" &&
      haystack.includes(needle);

export function runCheck(check: Check, observed: unknown): boolean {
  if (check.op === "anyNonEmpty")
    return check.paths.some((p) => !isEmpty(readPath(observed, p)));
  const actual = readPath(observed, check.path);
  switch (check.op) {
    case "eq":
      return same(actual, check.value);
    case "includes":
      return contains(actual, check.value);
    case "excludes":
      return !contains(actual, check.value);
    case "oneOf":
      return (
        Array.isArray(check.value) && check.value.some((v) => same(actual, v))
      );
    case "empty":
      return isEmpty(actual);
    case "nonEmpty":
      return !isEmpty(actual);
  }
}

/** Every check is a key field; a failed / missing observation scores all checks as wrong. */
export function scoreChecks(checks: Check[], observed: unknown | undefined) {
  const results = checks.map((c) => ({
    label: c.label,
    ok: observed !== undefined && runCheck(c, observed),
  }));
  return {
    correct: results.filter((r) => r.ok).length,
    total: results.length,
    failed: results.filter((r) => !r.ok).map((r) => r.label),
  };
}
