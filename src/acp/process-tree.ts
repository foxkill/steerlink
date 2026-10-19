import { spawnSync, type ChildProcess } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

/**
 * Ob ein Agent-Prozess eine eigene Prozessgruppe bekommt. Nur unter POSIX:
 * Dann lässt sich der ganze Baum (Adapter plus z. B. die Claude-Binary) über
 * die Gruppe beenden. Unter Windows würde `detached` ein eigenes
 * Konsolenfenster öffnen; dort beendet `taskkill /T` den Baum.
 */
export const SPAWN_IN_OWN_PROCESS_GROUP = !IS_WINDOWS;

function isRunning(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null;
}

function signalProcessGroup(pid: number): boolean {
    try {
        // Negative PID: das Signal geht an die ganze Prozessgruppe.
        process.kill(-pid, "SIGKILL");
        return true;
    } catch {
        return false;
    }
}

/**
 * Beendet einen laufenden Kindprozess samt allen Nachfahren sofort.
 * `child.kill()` allein trifft nur den direkten Kindprozess; dessen eigene
 * Kinder (etwa die native Claude-Binary) liefen sonst verwaist weiter.
 */
export function killProcessTree(child: ChildProcess): void {
    const { pid } = child;
    if (pid === undefined || !isRunning(child)) {
        return;
    }
    if (IS_WINDOWS) {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        return;
    }
    if (!signalProcessGroup(pid)) {
        child.kill("SIGKILL");
    }
}

/**
 * Räumt nach dem Ende eines Kindprozesses dessen übrig gebliebene Nachfahren
 * ab. Geht nur unter POSIX, solange die Prozessgruppe existiert. Unter
 * Windows ist der Baum nach dem Ende des Elternprozesses nicht mehr
 * auffindbar, und ein `taskkill` auf die PID könnte einen fremden Prozess
 * treffen, der sie inzwischen bekommen hat.
 */
export function killOrphanedDescendants(child: ChildProcess): void {
    const { pid } = child;
    if (pid === undefined || IS_WINDOWS || isRunning(child)) {
        return;
    }
    signalProcessGroup(pid);
}
