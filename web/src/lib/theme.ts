import type { Branding } from "./api";
export function applyTheme(b: Pick<Branding, "primary" | "accent"> | null | undefined, el: HTMLElement = document.documentElement) {
  if (!b) return;
  el.style.setProperty("--brand-primary", b.primary);
  el.style.setProperty("--brand-accent", b.accent);
}
