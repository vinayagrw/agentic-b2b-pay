import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reset, db } from "../src/modules/store.js";
import * as S from "../src/service.js";
import * as CP from "../src/copilot.js";
import * as SK from "../src/skills.js";
import * as P from "../src/platform.js";
import "../src/sparky.js";

beforeEach(() => { reset(); P.seedPlatform(); S.bootstrap(); });
const ctx = (id: string, scope: string | null): CP.Ctx => ({ user: P.getUser(id)!, scope, prefix: scope ? "/app" : "/operator" });
const names = () => CP.TOOLS.map((t) => t.name);

describe("copilot skills (mock mode)", () => {
  it("loads the six seeded skills and rejects a bad tool with a log line", () => {
    expect(CP.skills().map((s) => s.slug)).toEqual(["approval-backlog", "fx-exposure", "month-end-cash-review", "recon-exceptions", "spend-variance", "supplier-risk-check"]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sk-"));
    const w = (slug: string, tools: string) => { fs.mkdirSync(path.join(dir, slug)); fs.writeFileSync(path.join(dir, slug, "SKILL.md"), `---\nname: T\ndescription: d\ntools: [${tools}]\n---\n1. step\n`); };
    w("good-one", "spendBySupplier"); w("bad-one", "spendBySupplier, dropTables");
    const logs: string[] = []; const out = SK.loadSkills(dir, names(), (m) => logs.push(m));
    expect(out.map((s) => s.slug)).toEqual(["good-one"]); expect(logs[0]).toMatch(/bad-one skipped: unknown tool dropTables/);
    expect(() => SK.parseSkill("x-y", "no frontmatter", names())).toThrow(/frontmatter/);
  });
  it("enforces the tool allowlist on the server", () => {
    const jane = ctx("usr-cfo-jane", "tnt-acme"); const sk = CP.skills().find((s) => s.slug === "fx-exposure")!;
    expect(CP.runSkillTool(jane, sk, { name: "spendBySupplier", args: {} }).error).toMatch(/not part of/);
    expect(CP.runSkillTool(jane, sk, { name: "fxExposure", args: {} }).error).toBeUndefined();
    expect(CP.skillPlan(sk, "who are our top suppliers by spend", jane).every((p) => sk.tools.some((t) => t.name === p.name))).toBe(true);
  });
  it("blocks a disabled skill and only an admin can switch it", async () => {
    const jane = ctx("usr-cfo-jane", "tnt-acme");
    expect(() => SK.setSkill(CP.skills(), P.getUser("usr-clerk-pat")!, "tnt-acme", "approval-backlog", false)).toThrow(/admin/);
    SK.setSkill(CP.skills(), jane.user, "tnt-acme", "approval-backlog", false);
    await expect(CP.ask(jane, "/approval-backlog")).rejects.toThrow(/turned off/);
    expect(CP.skillsFor(jane).some((s) => s.slug === "approval-backlog")).toBe(false);
    expect(CP.skillsFor(ctx("usr-globex-gina", "tnt-globex")).some((s) => s.slug === "approval-backlog")).toBe(true);
    SK.setSkill(CP.skills(), P.getUser("usr-op-olivia")!, "tnt-acme", "approval-backlog", true);
    expect((await CP.ask(jane, "/approval-backlog")).skill?.slug).toBe("approval-backlog");
  });
  it("filters by role", async () => {
    const jane = ctx("usr-cfo-jane", "tnt-acme");
    expect(CP.skillsFor(jane).some((s) => s.slug === "recon-exceptions")).toBe(false);
    await expect(CP.ask(jane, "/recon-exceptions")).rejects.toThrow(/not available for your role/);
    expect(CP.skillsFor(ctx("usr-op-olivia", null)).some((s) => s.slug === "recon-exceptions")).toBe(true);
  });
  it("/spend-variance runs a two period query with a chart and leaves evidence", async () => {
    await S.runFlow("Need 50 sealed 6204 bearings");
    const a = await CP.ask(ctx("usr-cfo-jane", "tnt-acme"), "/spend-variance");
    expect(a.skill).toEqual({ slug: "spend-variance", name: "Spend variance" });
    const q = a.tools.find((t) => t.tool === "query")!; expect(q.error).toBeUndefined();
    expect(q.args).toMatchObject({ period: "month", dimension: "supplier", days: "62", measure: "amount_sum" });
    expect(a.chart?.spec?.type).toBe("bar"); expect(a.chart?.spec?.x).toBe("period");
    expect(db.evidence.some((e) => e.event === "copilot.skill" && e.subjectId === a.id)).toBe(true);
  });
  it("mock picks a skill by name", async () => {
    expect((await CP.ask(ctx("usr-cfo-jane", "tnt-acme"), "run the supplier risk check")).skill?.slug).toBe("supplier-risk-check");
  });
});
