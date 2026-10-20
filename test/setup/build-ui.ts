import { buildUi } from "../../scripts/build-ui.js";

/** The session view is served from dist/ui; build it once before the tests. */
export default async function setup(): Promise<void> {
    await buildUi();
}
