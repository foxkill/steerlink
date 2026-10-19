import { spawnSync, type ChildProcess } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

/**
 * Whether an agent process gets its own process group. POSIX only: there the
 * whole tree (the adapter plus e.g. the Claude binary) can be killed via the
 * group. On Windows `detached` would open a separate console window; there
 * `taskkill /T` kills the tree.
 */
export const SPAWN_IN_OWN_PROCESS_GROUP = !IS_WINDOWS;

function isRunning(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null;
}

function signalProcessGroup(pid: number): boolean {
    try {
        // Negative PID: the signal goes to the whole process group.
        process.kill(-pid, "SIGKILL");
        return true;
    } catch {
        return false;
    }
}

/**
 * Immediately kills a running child process along with all its descendants.
 * `child.kill()` alone only hits the direct child; its own children (such as
 * the native Claude binary) would otherwise keep running as orphans.
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
 * Cleans up a child process's leftover descendants after it has exited. Only
 * works on POSIX, as long as the process group still exists. On Windows the
 * tree can no longer be found once the parent has exited, and a `taskkill`
 * on the PID could hit an unrelated process that has since been given it.
 */
export function killOrphanedDescendants(child: ChildProcess): void {
    const { pid } = child;
    if (pid === undefined || IS_WINDOWS || isRunning(child)) {
        return;
    }
    signalProcessGroup(pid);
}
