import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP tool annotations (hints for hosts and directory listings, never a
 * security boundary: agent spending policy stays server-side). Each tool also
 * repeats its display title inside `annotations.title`, where older hosts and
 * directory scanners look for it.
 *
 * openWorldHint separates the caller's own GenesisPay records (false) from
 * answers made of third-party content (true): seller and shop listings,
 * external providers and other buyers' reviews.
 */
/** Reads only the caller's own account, payments or stored results. */
export const OWN_ACCOUNT_READ_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
};

/** Reads the directory: listings, shops, external providers and reviews written by third parties. */
export const DIRECTORY_READ_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};

/**
 * Mints a new server-side purchase key (MR-307): a write, so not read-only;
 * nothing is overwritten or charged, so not destructive; every call issues a
 * different key, so not idempotent. No third party is contacted.
 */
export const PURCHASE_KEY_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** A private 24-hour draft; each call creates a new draft. */
export const REVIEW_PREPARE_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Publishing or withdrawing public speech; a retry with the same identifiers is safe. */
export const REVIEW_PUBLIC_WRITE_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

export const PAY_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/** Orders and charges nothing, but asks a third-party shop for its quote. */
export const QUOTE_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};

/**
 * Writes the owner's one saved address (ADR-0108 D3/D6): a replace, not a
 * deletion, and saving the same details again changes nothing. It moves no
 * money; the guards are the owner email and the first-order approval.
 */
export const SHIPPING_PROFILE_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
