/**
 * Portable base64(JSON) helpers for x402 headers. Uses only web-standard
 * globals (TextEncoder/TextDecoder, btoa/atob) so the package runs in Node,
 * edge runtimes, and browsers without node builtins.
 */

export function encodeJsonBase64(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

export function decodeJsonBase64(encoded: string): unknown {
  const binary = atob(encoded.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
