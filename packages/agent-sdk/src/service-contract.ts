import { z } from "zod";

export const SERVICE_CONTRACT_MAX_BYTES = 16_384;
export const serviceListingIdSchema = z.union([
  z.uuid(),
  z.string().regex(/^prod_[A-Za-z0-9_-]{8,64}$/),
]);

const publicUrl = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
});
const revision = z.string().min(1).max(80);

export const serviceContractRefSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision,
});
export type ServiceContractRef = z.infer<typeof serviceContractRefSchema>;

/** Deliberately small JSON Schema subset: no references or executable extensions. */
export type ServiceInputSchema = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  properties?: Record<string, ServiceInputSchema>;
  required?: string[];
  additionalProperties?: boolean | ServiceInputSchema;
  items?: ServiceInputSchema;
  enum?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  uniqueItems?: boolean;
};

function schemaNode(depth: number): z.ZodType<ServiceInputSchema> {
  const child = depth > 0 ? schemaNode(depth - 1) : z.never();
  return z.strictObject({
    type: z.enum(["object", "array", "string", "number", "integer", "boolean"]),
    description: z.string().max(1000).optional(),
    properties: z.record(z.string().min(1).max(80), child)
      .refine((value) => Object.keys(value).length <= 40).optional(),
    required: z.array(z.string().min(1).max(80)).max(40).optional(),
    additionalProperties: z.union([z.boolean(), child]).optional(),
    items: child.optional(),
    enum: z.array(z.union([z.string().max(200), z.number(), z.boolean()])).max(40).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    uniqueItems: z.boolean().optional(),
  });
}

const inputSchema = schemaNode(4);

// Check a bounded tree before recursive JSON parsing or serialization. This is
// also used by SDK callers on unknown remote data; cycles fail at the depth cap.
function isBoundedJson(value: unknown, depth = 0, budget = { nodes: 4096 }): boolean {
  if (depth > 16 || --budget.nodes < 0) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= SERVICE_CONTRACT_MAX_BYTES;
  if (typeof value !== "object") return false;
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.length <= 2048 && values.every((item) => isBoundedJson(item, depth + 1, budget));
}

/** Advisory public data. It carries neither a price nor permission to purchase. */
export const serviceContractSchema = z.unknown().refine((value) => {
  if (!isBoundedJson(value)) return false;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= SERVICE_CONTRACT_MAX_BYTES;
}, "Service contract exceeds its JSON size or depth limits").pipe(z.strictObject({
  schemaVersion: z.literal(1),
  revision,
  method: z.enum(["GET", "POST"]),
  resourceUrl: publicUrl,
  input: z.strictObject({
    contentType: z.literal("application/json").optional(),
    bodySchema: inputSchema.optional(),
    querySchema: inputSchema.optional(),
  }),
  output: z.strictObject({
    contentType: z.string().min(1).max(100),
    delivery: z.enum(["inline_json", "async_job"]),
    description: z.string().min(1).max(1500),
  }),
  constraints: z.array(z.string().min(1).max(1000)).max(20),
  examples: z.array(z.strictObject({
    label: z.string().min(1).max(160),
    synthetic: z.literal(true),
    body: z.record(z.string(), z.json()).optional(),
    query: z.record(z.string(), z.string()).optional(),
  })).max(2),
  provenance: z.strictObject({
    source: z.enum(["seller", "curated"]),
    sourceUrl: publicUrl.optional(),
    checkedAt: z.iso.datetime(),
  }),
}).superRefine((value, context) => {
  if (value.method === "GET" && (value.input.bodySchema || value.input.contentType || value.examples.some((e) => e.body))) {
    context.addIssue({ code: "custom", message: "GET contracts cannot carry a body" });
  }
  if (value.method === "POST" && (!value.input.bodySchema || value.input.contentType !== "application/json")) {
    context.addIssue({ code: "custom", message: "POST contracts require an application/json body schema" });
  }
}));

export type ServiceContract = z.infer<typeof serviceContractSchema>;
