export type ConfirmState = "idle" | "asking";
/** Inline confirm: the first click asks, Yes runs, Cancel closes. */
export function confirmStep(s: ConfirmState, ev: "click" | "yes" | "cancel"): { state: ConfirmState; run: boolean } {
  if (ev === "click") return { state: "asking", run: false };
  if (ev === "yes" && s === "asking") return { state: "idle", run: true };
  return { state: "idle", run: false };
}
