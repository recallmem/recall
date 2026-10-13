import { unprocessable } from "../lib/errors.js";

type Obj = Record<string, unknown>;

const TYPES = new Set(["string", "number", "integer", "boolean", "null", "object", "array"]);
const REJECTED = ["allOf", "not", "if", "then", "else", "patternProperties"];
/** Accepted but never enforced: they travel to the model as prose hints only. */
const CONSTRAINTS = [
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "pattern",
  "format",
  "minProperties",
  "maxProperties",
  "uniqueItems",
  "default",
];
const MAX_DEPTH = 20;
const MAX_NODES = 500;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function fail(path: string, reason: string): never {
  throw unprocessable(`Invalid response_format: ${reason} (at ${path})`);
}

function defsOf(root: Obj): Obj {
  return {
    ...(isObj(root.definitions) ? root.definitions : {}),
    ...(isObj(root.$defs) ? root.$defs : {}),
  };
}

function refTarget(ref: unknown, root: Obj, path: string): Obj {
  const m = typeof ref === "string" ? ref.match(/^#\/(?:\$defs|definitions)\/([^/]+)$/) : null;
  if (!m) return fail(path, `unsupported $ref ${JSON.stringify(ref)}`);
  const def = defsOf(root)[m[1]!];
  if (def === undefined) return fail(path, `unknown $ref ${JSON.stringify(ref)}`);
  if (!isObj(def)) return fail(path, "a $ref target must be a schema object");
  return def;
}

/** Validates the supported JSON Schema subset (spec 01 §3.10.3); throws 422 with the offending path. */
export function validateResponseFormat(schema: unknown): void {
  if (!isObj(schema)) fail("$", "response_format must be a JSON Schema object");
  const root = schema;
  let nodes = 0;
  const walk = (node: unknown, path: string, depth: number, resolving: string[]): void => {
    if (typeof node === "boolean") fail(path, "boolean schemas are not supported");
    if (!isObj(node)) fail(path, "a schema must be an object");
    if (++nodes > MAX_NODES) fail(path, `schema has more than ${MAX_NODES} nodes`);
    if (depth > MAX_DEPTH) fail(path, `schema is nested deeper than ${MAX_DEPTH} levels`);
    for (const k of REJECTED) if (k in node) fail(path, `'${k}' is not supported`);
    if (path !== "$" && ("$defs" in node || "definitions" in node)) {
      fail(path, "$defs/definitions are only allowed at the root");
    }
    if ("$ref" in node) {
      const key = String(node.$ref);
      if (resolving.includes(key)) fail(path, `recursive $ref ${JSON.stringify(key)}`);
      walk({ ...refTarget(node.$ref, root, path), ...withoutRef(node) }, path, depth + 1, [
        ...resolving,
        key,
      ]);
      return;
    }
    if ("type" in node) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      for (const t of types)
        if (typeof t !== "string" || !TYPES.has(t)) fail(path, `unknown type ${JSON.stringify(t)}`);
    }
    if ("enum" in node) {
      const ok =
        Array.isArray(node.enum) &&
        node.enum.every((e) => e === null || ["string", "number", "boolean"].includes(typeof e));
      if (!ok) fail(path, "enum must be a list of strings, integers, booleans or null");
    }
    if (isObj(node.additionalProperties))
      fail(path, "schema-valued additionalProperties is not supported");
    if (isObj(node.properties)) {
      for (const [k, v] of Object.entries(node.properties))
        walk(v, `${path}.properties.${k}`, depth + 1, resolving);
    } else if ("properties" in node) fail(path, "properties must be an object");
    if ("items" in node) {
      if (Array.isArray(node.items)) fail(path, "tuple-style items are not supported");
      walk(node.items, `${path}.items`, depth + 1, resolving);
    }
    for (const k of ["anyOf", "oneOf"] as const) {
      if (!(k in node)) continue;
      const alts = node[k];
      if (!Array.isArray(alts)) fail(path, `${k} must be a list`);
      for (const [i, alt] of alts.entries()) walk(alt, `${path}.${k}[${i}]`, depth + 1, resolving);
    }
  };
  walk(root, "$", 0, []);
  const resolved =
    "$ref" in root ? { ...refTarget(root.$ref, root, "$"), ...withoutRef(root) } : root;
  const types = Array.isArray(resolved.type) ? resolved.type : [resolved.type];
  if (!types.includes("object")) fail("$", "the root must be of type 'object'");
}

function withoutRef(node: Obj): Obj {
  const { $ref: _ref, ...rest } = node;
  return rest;
}

function resolve(node: Obj, root: Obj): Obj {
  let cur = node;
  for (let i = 0; i < 20 && "$ref" in cur; i++)
    cur = { ...refTarget(cur.$ref, root, "$"), ...withoutRef(cur) };
  return cur;
}

function nullable(node: Obj): Obj {
  if (typeof node.type === "string")
    return {
      ...node,
      type: [node.type, "null"],
      ...(node.enum ? { enum: [...(node.enum as unknown[]), null] } : {}),
    };
  if (Array.isArray(node.type))
    return node.type.includes("null") ? node : { ...node, type: [...node.type, "null"] };
  if (Array.isArray(node.anyOf)) return { ...node, anyOf: [...node.anyOf, { type: "null" }] };
  return { anyOf: [node, { type: "null" }] };
}

/**
 * Provider-ready schema: $refs inlined, every object closed with all properties
 * required (optional ones become nullable) and constraint keywords removed, which
 * is the dialect strict structured-output modes accept.
 */
export function toProviderSchema(schema: Obj): Obj {
  const strictify = (input: Obj): Obj => {
    const node = resolve(input, schema);
    const out: Obj = {};
    if (node.description !== undefined) out.description = node.description;
    if (node.type !== undefined) out.type = node.type;
    if (node.enum !== undefined) out.enum = node.enum;
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (isObj(node.properties) || types.includes("object")) {
      const props = isObj(node.properties) ? node.properties : {};
      const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
      out.properties = Object.fromEntries(
        Object.entries(props).map(([k, v]) => {
          const child = strictify(v as Obj);
          return [k, required.has(k) ? child : nullable(child)];
        }),
      );
      out.required = Object.keys(props);
      out.additionalProperties = false;
    }
    if (types.includes("array"))
      out.items = isObj(node.items) ? strictify(node.items) : { type: "string" };
    for (const k of ["anyOf", "oneOf"] as const) {
      if (Array.isArray(node[k])) out.anyOf = (node[k] as Obj[]).map(strictify);
    }
    return out;
  };
  return strictify(schema);
}

/** Drops keys the schema does not declare and nulls that stand in for omitted optional properties. */
export function projectToSchema(value: unknown, schema: Obj, root: Obj = schema): unknown {
  const node = resolve(schema, root);
  if (isObj(value) && isObj(node.properties)) {
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    const out: Obj = {};
    for (const [k, def] of Object.entries(node.properties)) {
      if (!(k in value)) continue;
      if (value[k] === null && !required.has(k)) continue;
      out[k] = isObj(def) ? projectToSchema(value[k], def, root) : value[k];
    }
    return out;
  }
  if (Array.isArray(value) && isObj(node.items))
    return value.map((v) => projectToSchema(v, node.items as Obj, root));
  for (const k of ["anyOf", "oneOf"] as const) {
    if (!Array.isArray(node[k])) continue;
    const alt = (node[k] as Obj[]).find((a) => {
      const t = resolve(a, root).type;
      const ts = Array.isArray(t) ? t : [t];
      if (isObj(value)) return ts.includes("object");
      if (Array.isArray(value)) return ts.includes("array");
      return value !== null;
    });
    if (alt) return projectToSchema(value, alt, root);
  }
  return value;
}

/** Constraint keywords found anywhere in the schema, so the prompt can mention them as hints. */
export function hasConstraintHints(schema: Obj): boolean {
  return JSON.stringify(schema)
    .split('"')
    .some((s) => CONSTRAINTS.includes(s));
}
