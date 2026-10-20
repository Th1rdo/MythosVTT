import { h } from "../dom.ts";
import { t } from "../i18n.ts";

/**
 * Per-browser GUI size for the three parts of the shell. Stored locally (it depends on the screen,
 * not the world) and applied as CSS variables that the layout scales by.
 */
export interface UiScale {
  left: number;
  right: number;
  hotbar: number;
}

const KEY = "mesa.uiScale";
const DEFAULT: UiScale = { left: 1, right: 1, hotbar: 1 };
export const MIN_SCALE = 0.6;
export const MAX_SCALE = 1.6;

export function readUiScale(): UiScale {
  try {
    const v = { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    for (const k of Object.keys(DEFAULT) as (keyof UiScale)[]) {
      v[k] = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(v[k]) || 1));
    }
    return v;
  } catch {
    return { ...DEFAULT };
  }
}

export function applyUiScale(s: UiScale): void {
  const root = document.documentElement.style;
  root.setProperty("--ui-left", String(s.left));
  root.setProperty("--ui-right", String(s.right));
  root.setProperty("--ui-hotbar", String(s.hotbar));
}

function save(s: UiScale): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode: the size applies for this visit only.
  }
}

/** Sliders for the settings tab. */
export function uiScaleSettings(): HTMLElement {
  const s = readUiScale();
  const slider = (key: keyof UiScale, label: string) => {
    const value = h("span.scale-value", null, `${Math.round(s[key] * 100)}%`);
    const input = h("input", {
      type: "range", min: MIN_SCALE, max: MAX_SCALE, step: 0.05, value: String(s[key]),
      oninput: (e: Event) => {
        s[key] = Number((e.target as HTMLInputElement).value);
        value.textContent = `${Math.round(s[key] * 100)}%`;
        applyUiScale(s);
        save(s);
      }
    });
    return h("label.field.scale-field", null, h("span.row", null, h("span.grow", null, label), value), input);
  };
  const reset = () => {
    Object.assign(s, DEFAULT);
    applyUiScale(s);
    save(s);
    for (const input of box.querySelectorAll<HTMLInputElement>("input[type=range]")) input.value = "1";
    for (const v of box.querySelectorAll(".scale-value")) v.textContent = "100%";
  };
  const box = h("div.settings-block", null,
    h("h4", null, t("Tamanho da interface (só neste browser)")),
    slider("left", t("Barra esquerda (controlos, cenas, jogadores)")),
    slider("right", t("Barra direita (separadores e painel)")),
    slider("hotbar", t("Barra de macros")),
    h("div.row.end", null, h("button.small", { onclick: reset }, t("Repor 100%")))
  );
  return box;
}
