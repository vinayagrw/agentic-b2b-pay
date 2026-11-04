import type { Branding } from "./api";

/** Parse #rgb or #rrggbb into 0..255 channels. Returns null for anything else. */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG 2.x relative luminance. */
export function luminance(hex: string): number {
  const rgb = parseHex(hex); if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const INK_DARK = "#0b1020";
export const INK_LIGHT = "#ffffff";

/** The text colour to place on a background: whichever of near black or white reads better. */
export function readableOn(bg: string): string {
  return contrast(bg, INK_LIGHT) >= contrast(bg, INK_DARK) ? INK_LIGHT : INK_DARK;
}

/** Does this pair meet WCAG AA for normal text (4.5) or large text (3)? */
export const meetsAA = (fg: string, bg: string, large = false) => contrast(fg, bg) >= (large ? 3 : 4.5);

/** Every CSS variable a bank theme sets. Text colours are derived, never stored. */
export function themeVars(b: Pick<Branding, "primary" | "accent">): Record<string, string> {
  return {
    "--brand-primary": b.primary, "--brand-accent": b.accent,
    "--brand-primary-fg": readableOn(b.primary), "--brand-accent-fg": readableOn(b.accent),
  };
}

export function applyTheme(b: Pick<Branding, "primary" | "accent"> | null | undefined, el: HTMLElement = document.documentElement) {
  if (!b) return;
  for (const [k, v] of Object.entries(themeVars(b))) el.style.setProperty(k, v);
}
