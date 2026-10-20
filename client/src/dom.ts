import DOMPurify from "dompurify";

type Child = Node | string | null | undefined | false;

/** Tiny element builder: h("div#id.card", {onclick}, "text", child). Text is always inserted as text. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | `${K}.${string}` | `${K}#${string}`,
  props: Record<string, any> | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const [head, ...classes] = tag.split(".");
  const [name, id] = head.split("#");
  const el = document.createElement(name) as HTMLElementTagNameMap[K];
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") {
      // Custom properties (--x) can't be assigned as style properties.
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith("--")) el.style.setProperty(sk, String(sv));
        else (el.style as any)[sk] = sv;
      }
    }
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && k !== "list") (el as any)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Replace an element's children, skipping null/false entries. */
export function setChildren(el: Element, ...children: (Child | Child[])[]): void {
  el.replaceChildren(...children.flat().filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
}

/** Render untrusted HTML (journal entries, imported chat cards) with scripts and handlers removed. */
export function safeHtml(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ["style", "form", "input", "button"] });
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join("") || "?";
}

/** Avatar: the image if there is one, otherwise coloured initials. */
export function avatar(img: string | null | undefined, name: string, size = 36): HTMLElement {
  if (img) return h("img.avatar", { src: img, alt: "", width: size, height: size, loading: "lazy" });
  return h("span.avatar.initials", { style: { width: `${size}px`, height: `${size}px`, fontSize: `${size * 0.4}px` } }, initials(name));
}

export function timeLabel(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("pt-PT");
}

/** Ask the server to store a file; returns its /assets path. GM only. */
export async function upload(file: File): Promise<string> {
  const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Falha no upload");
  return json.path;
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = h("input", { type: "file", accept });
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.click();
  });
}

export function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = src;
  });
}
