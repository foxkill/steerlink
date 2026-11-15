import createDOMPurify, { type Config } from "dompurify";
import { marked } from "marked";

const DOMPurify = createDOMPurify(window);

function escapeHtml(text: string): string {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// breaks: a single newline stays a line break, as it was when messages were plain text.
marked.setOptions({ gfm: true, breaks: true });
marked.use({
    renderer: {
        html({ text }) {
            return escapeHtml(text);
        },
    },
});

const SANITIZE: Config = {
    FORBID_TAGS: [
        "script",
        "style",
        "iframe",
        "object",
        "embed",
        "form",
        "input",
        "textarea",
        "button",
        "meta",
        "link",
        "base",
    ],
    ALLOWED_TAGS: [
        "p",
        "br",
        "strong",
        "em",
        "del",
        "code",
        "pre",
        "ul",
        "ol",
        "li",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "a",
        "blockquote",
        "hr",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
    ],
    ALLOWED_ATTR: ["href", "title", "class"],
};

/** Renders agent/user Markdown into a sanitized element for the session view. */
export function markdownBody(text: string): HTMLElement {
    const raw = marked.parse(text, { async: false });
    const html = typeof raw === "string" ? raw : "";
    const box = document.createElement("div");
    box.className = "md";
    box.innerHTML = DOMPurify.sanitize(html, SANITIZE);
    for (const link of box.querySelectorAll("a[href]")) {
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
    }
    return box;
}
