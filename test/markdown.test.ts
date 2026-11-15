// @vitest-environment jsdom
// jsdom, not happy-dom: DOMPurify does not sanitize reliably in happy-dom.

import { describe, expect, it } from "vitest";

import { markdownBody } from "../ui/session-view/markdown.js";

describe("session view markdown", () => {
    it("renders emphasis and shows raw HTML as text", () => {
        const root = markdownBody("**bold** and <script>alert(1)</script>");
        expect(root.querySelector("strong")?.textContent).toBe("bold");
        expect(root.querySelector("script")).toBeNull();
        expect(root.textContent).toContain("<script>alert(1)</script>");
    });

    it("shows an HTML block as text", () => {
        const root = markdownBody("<img src=x onerror=alert(1)>\n\n<b>hi</b>");
        expect(root.querySelector("img")).toBeNull();
        expect(root.querySelector("b")).toBeNull();
        expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
    });

    it("opens links in a new tab", () => {
        const root = markdownBody("[docs](https://example.com/doc)");
        const link = root.querySelector("a");
        expect(link?.getAttribute("href")).toBe("https://example.com/doc");
        expect(link?.getAttribute("target")).toBe("_blank");
        expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    });

    it("drops the target of a script link", () => {
        const link = markdownBody("[x](javascript:alert(1))").querySelector("a");
        expect(link?.textContent).toBe("x");
        expect(link?.hasAttribute("href")).toBe(false);
        expect(link?.hasAttribute("target")).toBe(false);
    });

    it("removes images, so the view loads nothing from outside", () => {
        const root = markdownBody("before ![alt](https://example.com/p.png) after");
        expect(root.querySelector("img")).toBeNull();
        expect(root.innerHTML).not.toContain("example.com");
    });

    it("removes the checkboxes of task lists", () => {
        const root = markdownBody("- [ ] task\n- [x] done");
        expect(root.querySelector("input")).toBeNull();
        expect(root.querySelectorAll("li")).toHaveLength(2);
    });

    it("keeps a single newline as a line break", () => {
        const root = markdownBody("line1\nline2");
        expect(root.querySelectorAll("br")).toHaveLength(1);
    });

    it("renders fenced code and tables", () => {
        const code = markdownBody("```ts\nconst a = '<b>';\n```");
        expect(code.querySelector("pre code")?.textContent).toBe("const a = '<b>';\n");
        const table = markdownBody("| a | b |\n|---|---|\n| 1 | 2 |");
        expect(table.querySelectorAll("th")).toHaveLength(2);
        expect(table.querySelectorAll("td")).toHaveLength(2);
    });
});
