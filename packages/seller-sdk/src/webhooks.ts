// Webhook signature verification for PeerDirect deliveries.
//
// The server signs every delivery in `src/features/sellers/webhooks.ts`:
//
//   PEERPAY-SIGNATURE: t=<unix-seconds>,v1=<hex>
//   v1 = HMAC_SHA256(secret, `${t}.${rawBody}`)
//
// Deliberately implemented on WebCrypto (`globalThis.crypto.subtle`) rather
// than `node:crypto` so the SDK also runs on Edge runtimes, Cloudflare Workers
// and Bun. That is why `constructEvent` is async — a conscious deviation from
// Stripe's synchronous `constructEvent`.

/**
 * Every event type this SDK version knows. Mirrors the server's
 * `WebhookEventType` (`src/features/sellers/webhooks.ts`) — the drift alarm is
 * `src/features/sellers/webhook-signature-contract.test.ts`, which fails when
 * the server grows a type this list does not have.
 *
 * Exported as a runtime array (not only as a type) so a handler can ask
 * `isKnownPeerPayEventType(event.type)` before it decides what to do.
 */
export const PEERPAY_EVENT_TYPES = [
  "payment.confirmed",
  "link.paid",
  "agent_payment.pending_approval",
  "agent_payment.settled",
  "mandate.active",
  "mandate.charged",
  "mandate.charge_failed",
  "mandate.revoked",
  "subscription.renewed",
  "subscription.past_due",
] as const;

/** Union of the event types this SDK version knows. */
export type PeerPayEventType = (typeof PEERPAY_EVENT_TYPES)[number];

/** True when `type` is an event type this SDK version knows about. */
export function isKnownPeerPayEventType(type: string): type is PeerPayEventType {
  return (PEERPAY_EVENT_TYPES as readonly string[]).includes(type);
}

/** Shared envelope; `type`/`data` are pinned per event by the union below. */
type PeerPayEventEnvelope<TType extends string, TData> = {
  /** Stable across delivery retries — the idempotency key to dedupe on. */
  id: string;
  type: TType;
  createdAt: string;
  data: TData;
};

/**
 * `data` of `payment.confirmed` / `link.paid`. Mirrors the server's
 * `PaymentWebhookEventPayload`; amounts stay strings (minor units are `bigint`
 * on the server and would lose precision as a JSON number).
 */
export type PeerPayPaymentEventData = {
  link: {
    publicId: string;
    title: string;
    amountUsdcMinor: string;
    amountUsdc: string;
    linkType: "single" | "reusable";
    /** Correlation data set at link creation, echoed verbatim. */
    metadata: Record<string, string> | null;
    clientReferenceId: string | null;
  };
  attempt: {
    id: string;
    /** `null` for simulated payments — there is no transaction to link to. */
    txHash: string | null;
    payerWallet: string | null;
    createdAt: string;
    confirmedAt: string | null;
    /** True for test-mode `simulate-payment` attempts; `false` for real money. */
    simulated: boolean;
  };
  occurredAt: string;
};

/** `data` of the mandate/subscription events; mirrors `buildMandateWebhookPayload`. */
export type PeerPayMandateEventData = {
  mandate: {
    id: string;
    kind: string;
    status: string;
    payerWallet: string;
    /**
     * Which plan the subscription belongs to — without it a `mandate.active`
     * handler knows *that* someone subscribed but not *to what*. `null` for
     * mandates proposed directly rather than through a plan checkout. Like
     * every field here it mirrors the current server payload and is not
     * re-validated at runtime, so read it as `?? null` if you also accept
     * deliveries from a deployment that predates the field.
     */
    subscriptionPlanId: string | null;
    asset: string;
    allowanceMinor: string;
    capPerChargeMinor: string;
    spentMinor: string;
    amountPerPeriodMinor: string | null;
    periodDays: number | null;
    nextChargeAt: string | null;
  };
  charge: {
    id: string;
    kind: string;
    amountMinor: string;
    status: string;
    txHash: string | null;
    resourceUrl: string | null;
    failureReason: string | null;
  } | null;
  occurredAt: string;
};

export type PeerPayPaymentEvent = PeerPayEventEnvelope<
  "payment.confirmed" | "link.paid",
  PeerPayPaymentEventData
>;

export type PeerPayMandateEvent = PeerPayEventEnvelope<
  | "mandate.active"
  | "mandate.charged"
  | "mandate.charge_failed"
  | "mandate.revoked"
  | "subscription.renewed"
  | "subscription.past_due",
  PeerPayMandateEventData
>;

/**
 * Agent-payment events are reserved on the server but have no emitter yet, so
 * their payload is deliberately left open rather than invented here.
 */
export type PeerPayAgentPaymentEvent = PeerPayEventEnvelope<
  "agent_payment.pending_approval" | "agent_payment.settled",
  Record<string, unknown>
>;

/**
 * An event type this SDK version does not know — a newer server talking to an
 * older SDK. It is a *valid* event: `constructEvent` verifies and returns it
 * like any other (see `PeerPayAnyEvent`), it never throws on the type.
 */
export type PeerPayUnknownEvent = PeerPayEventEnvelope<
  string,
  Record<string, unknown>
>;

/**
 * Verified webhook delivery, discriminated on `type`:
 *
 * ```ts
 * if (event.type === "payment.confirmed") {
 *   event.data.attempt.txHash; // typed, no cast
 * }
 * ```
 *
 * **Why this union has no `{ type: string & {} }` member.** TypeScript only
 * narrows on a discriminant whose type is a literal in *every* constituent: add
 * one member with a plain `string` type and `event.type === "payment.confirmed"`
 * stops narrowing `data` for all the others too — the exact regression R1 sets
 * out to fix. Forward compatibility therefore lives at runtime (an unknown type
 * is verified and returned, never rejected) plus in `PeerPayAnyEvent` /
 * `PeerPayUnknownEvent` for handlers that want to model the open world:
 *
 * ```ts
 * const any: PeerPayAnyEvent = event;            // widens, no cast needed
 * if (!isKnownPeerPayEventType(any.type)) return new Response("ok"); // ack & ignore
 * ```
 */
export type PeerPayEvent =
  | PeerPayPaymentEvent
  | PeerPayMandateEvent
  | PeerPayAgentPaymentEvent;

/**
 * Open-world view of a delivery: every known event widens to it, and it is the
 * honest type for an event whose `type` this SDK version does not know.
 */
export type PeerPayAnyEvent = PeerPayEvent | PeerPayUnknownEvent;

/**
 * Thrown for every rejection path: malformed/missing header, missing `t`/`v1`,
 * timestamp outside the tolerance window, signature mismatch, non-JSON body.
 * Messages never contain the secret or the expected signature.
 */
export class PeerPaySignatureVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerPaySignatureVerificationError";
  }
}

export type ConstructEventOptions = {
  /** Replay window in seconds, applied in both directions. Default 300. */
  toleranceSeconds?: number;
  /** Injectable clock (epoch milliseconds); defaults to `Date.now()`. */
  nowMs?: number;
};

const DEFAULT_TOLERANCE_SECONDS = 300;
const SIGNATURE_HEADER_NAME = "PEERPAY-SIGNATURE";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

type ParsedSignatureHeader = {
  timestampSeconds: number;
  signatures: string[];
};

/**
 * Parses `t=…,v1=…` tolerantly: any order, surrounding whitespace, and
 * repeated `v1=` values (secret rotation — one match is enough).
 */
function parseSignatureHeader(header: string): ParsedSignatureHeader {
  let timestampRaw: string | undefined;
  const signatures: string[] = [];

  for (const rawPart of header.split(",")) {
    const part = rawPart.trim();
    if (part.length === 0) continue;

    const separator = part.indexOf("=");
    if (separator <= 0) {
      throw new PeerPaySignatureVerificationError(
        `Malformed ${SIGNATURE_HEADER_NAME} header: expected comma-separated key=value pairs.`,
      );
    }

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === "t") {
      // A second `t=` would make the signed payload ambiguous.
      if (timestampRaw !== undefined) {
        throw new PeerPaySignatureVerificationError(
          `Malformed ${SIGNATURE_HEADER_NAME} header: duplicate "t" value.`,
        );
      }
      timestampRaw = value;
    } else if (key === "v1") {
      if (value.length > 0) signatures.push(value);
    }
    // Unknown keys (future scheme versions) are ignored on purpose.
  }

  if (timestampRaw === undefined || timestampRaw.length === 0) {
    throw new PeerPaySignatureVerificationError(
      `Missing "t" in ${SIGNATURE_HEADER_NAME} header.`,
    );
  }

  if (!/^\d+$/.test(timestampRaw)) {
    throw new PeerPaySignatureVerificationError(
      `Invalid "t" in ${SIGNATURE_HEADER_NAME} header: expected unix seconds.`,
    );
  }

  const timestampSeconds = Number(timestampRaw);
  if (!Number.isSafeInteger(timestampSeconds)) {
    throw new PeerPaySignatureVerificationError(
      `Invalid "t" in ${SIGNATURE_HEADER_NAME} header: expected unix seconds.`,
    );
  }

  if (signatures.length === 0) {
    throw new PeerPaySignatureVerificationError(
      `Missing "v1" in ${SIGNATURE_HEADER_NAME} header.`,
    );
  }

  return { timestampSeconds, signatures };
}

function getSubtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new PeerPaySignatureVerificationError(
      "WebCrypto (globalThis.crypto.subtle) is unavailable in this runtime; webhook verification requires it.",
    );
  }
  return subtle;
}

async function computeExpectedSignature(
  secret: string,
  signedPayload: string,
): Promise<string> {
  const subtle = getSubtleCrypto();
  const key = await subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(signedPayload),
  );
  return toHex(new Uint8Array(signature));
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Constant-time string comparison. Length is checked first (lengths are not
 * secret), then every byte is folded into an XOR accumulator — no early return
 * and no `===` on the hex strings, so timing does not leak the position of the
 * first differing byte.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function decodeRawBody(rawBody: string | Uint8Array): string {
  if (typeof rawBody === "string") return rawBody;
  return textDecoder.decode(rawBody);
}

/**
 * Verifies a PeerDirect webhook delivery and returns the parsed event.
 *
 * Pass the **raw** request body exactly as received — never a re-serialized
 * `JSON.parse` + `JSON.stringify` round trip, which changes the bytes and
 * invalidates the signature. Parsing happens only after verification succeeds.
 *
 * An event type this SDK version does not know is **not** a failure: the
 * delivery is verified and returned unchanged, so a server that adds a new
 * event type can never turn a customer's webhook route into a 400. Only the
 * signature and the envelope (`id`, `type`, `createdAt`, object `data`) can
 * reject a delivery. Widen to `PeerPayAnyEvent` and use
 * `isKnownPeerPayEventType()` if you want to handle that case explicitly.
 *
 * @throws {PeerPaySignatureVerificationError} on any verification failure.
 *
 * @example
 * ```ts
 * const event = await constructEvent(
 *   await request.text(),
 *   request.headers.get("peerpay-signature") ?? "",
 *   process.env.PEERPAY_WEBHOOK_SECRET!,
 * );
 * if (event.type === "payment.confirmed") {
 *   fulfil(event.data.link.clientReferenceId, event.data.attempt.txHash);
 * }
 * ```
 */
export async function constructEvent(
  rawBody: string | Uint8Array,
  signatureHeader: string,
  secret: string,
  opts: ConstructEventOptions = {},
): Promise<PeerPayEvent> {
  if (typeof signatureHeader !== "string" || signatureHeader.trim().length === 0) {
    throw new PeerPaySignatureVerificationError(
      `Missing ${SIGNATURE_HEADER_NAME} header.`,
    );
  }

  if (typeof secret !== "string" || secret.length === 0) {
    throw new PeerPaySignatureVerificationError(
      "Missing webhook signing secret.",
    );
  }

  const toleranceSeconds = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new PeerPaySignatureVerificationError(
      "Invalid toleranceSeconds: expected a non-negative number.",
    );
  }

  const { timestampSeconds, signatures } = parseSignatureHeader(signatureHeader);

  const nowMs = opts.nowMs ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1_000);
  const skewSeconds = Math.abs(nowSeconds - timestampSeconds);
  if (skewSeconds > toleranceSeconds) {
    // Rejects future timestamps too — a clock-skewed or replayed delivery.
    throw new PeerPaySignatureVerificationError(
      `Webhook timestamp is outside the tolerance window of ${toleranceSeconds}s (off by ${skewSeconds}s).`,
    );
  }

  const body = decodeRawBody(rawBody);
  const expected = await computeExpectedSignature(
    secret,
    `${timestampSeconds}.${body}`,
  );

  let matched = false;
  for (const candidate of signatures) {
    // No early break: every candidate is compared so the work does not depend
    // on which one matches.
    matched = timingSafeEqualStrings(expected, candidate.toLowerCase()) || matched;
  }

  if (!matched) {
    throw new PeerPaySignatureVerificationError(
      "Webhook signature mismatch: the payload does not match the signing secret.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PeerPaySignatureVerificationError(
      "Webhook body is not valid JSON.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PeerPaySignatureVerificationError(
      "Webhook body is not a JSON object.",
    );
  }

  // The envelope is asserted rather than cast. `id` in particular is the
  // documented idempotency key — it is stable across delivery retries, so an
  // integrator deduping on it would silently process a payment twice if it
  // arrived as undefined. A signed body that does not carry the envelope means
  // the sender is not the PeerPay we know, so failing here is correct.
  const envelope = parsed as Partial<PeerPayUnknownEvent>;
  for (const field of ["id", "type", "createdAt"] as const) {
    if (typeof envelope[field] !== "string" || envelope[field] === "") {
      throw new PeerPaySignatureVerificationError(
        `Webhook body is missing a string "${field}" field.`,
      );
    }
  }
  if (
    typeof envelope.data !== "object" ||
    envelope.data === null ||
    Array.isArray(envelope.data)
  ) {
    throw new PeerPaySignatureVerificationError(
      'Webhook body is missing an object "data" field.',
    );
  }

  return parsed as PeerPayEvent;
}
