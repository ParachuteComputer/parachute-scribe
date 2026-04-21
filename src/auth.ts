/**
 * Single seam for all authorization decisions. Today: shared-secret bearer
 * token from SCRIBE_AUTH_TOKEN. Tomorrow (hub-issued JWTs): swap the body
 * of `validateToken` — callers don't change.
 */

export type AuthResult =
  | { valid: true; scopes: readonly string[] }
  | { valid: false; reason: "token-required" | "token-mismatch" };

export const AUTH_EXEMPT_PATHS = new Set(["/health", "/.parachute/info"]);

export function extractBearer(authHeader: string | null | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

export function validateToken(token: string | undefined): AuthResult {
  const required = process.env.SCRIBE_AUTH_TOKEN;
  if (!required) return { valid: true, scopes: [] };
  if (!token) return { valid: false, reason: "token-required" };
  if (token !== required) return { valid: false, reason: "token-mismatch" };
  return { valid: true, scopes: ["scribe:transcribe", "scribe:admin"] };
}

export function isAuthRequired(): boolean {
  return Boolean(process.env.SCRIBE_AUTH_TOKEN);
}

export function unauthorizedResponse(): Response {
  return Response.json(
    { error: "unauthorized", message: "SCRIBE_AUTH_TOKEN required" },
    { status: 401 },
  );
}

export function enforceAuth(req: Request, pathname: string): Response | null {
  if (AUTH_EXEMPT_PATHS.has(pathname)) return null;
  const token = extractBearer(req.headers.get("authorization"));
  const result = validateToken(token);
  if (result.valid) return null;
  return unauthorizedResponse();
}
