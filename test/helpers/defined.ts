/**
 * Returns `value` or aborts the test with a clear message.
 * Replaces `!` and unchecked index access in tests.
 */
export function defined<T>(value: T | null | undefined, what: string): T {
    if (value === undefined || value === null) {
        throw new Error(`Expected but missing: ${what}`);
    }
    return value;
}
