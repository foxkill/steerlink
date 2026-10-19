/**
 * A value like `${ANTHROPIC_API_KEY}`: a placeholder from a plugin
 * configuration (mcp.json) that the host did not expand because the variable
 * was never set. It must never pass for a real value. Also covers host
 * variants such as `${env:NAME}` or `${userHome}`.
 */
const UNEXPANDED_PLACEHOLDER = /^\$\{[^{}\s]+\}$/;

export function isUnexpandedPlaceholder(value: string): boolean {
    return UNEXPANDED_PLACEHOLDER.test(value.trim());
}

/** Reads a variable; empty values and unexpanded placeholders count as unset. */
export function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
    const value = env[name];
    if (typeof value !== "string" || value.length === 0 || isUnexpandedPlaceholder(value)) {
        return undefined;
    }
    return value;
}
