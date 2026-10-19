/**
 * Gibt `value` zurück oder bricht den Test mit einer klaren Meldung ab.
 * Ersetzt `!` und ungeprüfte Indexzugriffe in Tests.
 */
export function defined<T>(value: T | null | undefined, what: string): T {
    if (value === undefined || value === null) {
        throw new Error(`Erwartet, aber nicht vorhanden: ${what}`);
    }
    return value;
}
