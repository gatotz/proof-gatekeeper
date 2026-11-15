import crypto from "node:crypto";

export const SIGNATURE_HEADER = "x-agent-games-signature";

/**
 * HMAC-SHA256 over the RAW request/response body.
 *
 * ASSUMPTION (see README): the header carries the hex digest, optionally
 * prefixed with "sha256=". The platform docs only say "Verify the HMAC
 * signature against the raw body" / "Every response is signed with
 * x-agent-games-signature over the raw response body" — the exact digest
 * encoding is not specified. Hex (with optional sha256= prefix) is the
 * standard convention; verify against a practice task before the first
 * scored round.
 */
export function signBody(secret: string, body: Buffer): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(
  secret: string,
  body: Buffer,
  header: string | undefined,
): boolean {
  if (!header) return false;
  const given = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  let givenBuf: Buffer;
  try {
    givenBuf = Buffer.from(given, "hex");
  } catch {
    return false;
  }
  if (givenBuf.length !== 32) return false;
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  return crypto.timingSafeEqual(givenBuf, expected);
}
