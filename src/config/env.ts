/**
 * Ein Wert wie `${ANTHROPIC_API_KEY}`: ein Platzhalter aus einer
 * Plugin-Konfiguration (mcp.json), den der Host nicht ersetzt hat, weil die
 * Variable nie gesetzt wurde. Er darf nie als echter Wert durchgehen.
 */
const UNEXPANDED_PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export function isUnexpandedPlaceholder(value: string): boolean {
  return UNEXPANDED_PLACEHOLDER.test(value.trim());
}

/** Liest eine Variable; leere Werte und nicht ersetzte Platzhalter gelten als nicht gesetzt. */
export function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0 || isUnexpandedPlaceholder(value)) {
    return undefined;
  }
  return value;
}
