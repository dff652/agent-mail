/** Client connection.json policy: never embed plaintext secrets (SECURITY.md). */

const FORBIDDEN_KEYS = [
  "bearer",
  "token",
  "authorization",
  "hub_token",
  "access_token",
  "password",
  "secret",
];

export function rejectPlaintextSecretsInConnection(
  obj: Record<string, unknown>,
  pathPrefix = "",
): void {
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (
      FORBIDDEN_KEYS.some((f) => lower === f || lower.endsWith(`_${f}`)) &&
      typeof value === "string" &&
      value.trim().length > 0
    ) {
      throw new Error(
        `connection.json must not embed plaintext secret field ${pathPrefix}${key}; use token_file`,
      );
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      rejectPlaintextSecretsInConnection(
        value as Record<string, unknown>,
        `${pathPrefix}${key}.`,
      );
    }
  }
}
