import { describe, expect, it } from "vitest";
import { appPath, readCard } from "../src/lib/chat";

const slack = { blocks: [{ type: "header", text: { text: "Approval needed: po-1" } }, { type: "section", fields: [{ text: "*Supplier*\nNorthwind" }, { text: "*Amount*\n$2,000.00" }] },
  { type: "actions", elements: [{ action_id: "approve", text: { text: "Approve" }, value: "cat1.a.b" }, { action_id: "reject", text: { text: "Reject" }, value: "cat1.c.d" }, { action_id: "open", text: { text: "Open in app" }, url: "http://localhost:5180/app/approvals?po=po-1" }] }] };
const teams = { attachments: [{ content: { body: [{ text: "Approval needed: po-1" }, { type: "FactSet", facts: [{ title: "Supplier", value: "Northwind" }] }, { text: "Approved by Lee Park" }], actions: [{ type: "Action.OpenUrl", title: "Open in app", url: "http://x/app/approvals?po=po-1" }] } }] };

describe("chat card preview", () => {
  it("reads Slack blocks", () => { const v = readCard("slack", slack); expect(v.title).toBe("Approval needed: po-1"); expect(v.fields[0]).toEqual({ label: "Supplier", value: "Northwind" }); expect(v.buttons.map((b) => b.kind)).toEqual(["approve", "reject", "open"]); expect(v.buttons[0].token).toBe("cat1.a.b"); expect(v.state).toBeNull(); });
  it("reads a decided Teams card", () => { const v = readCard("teams", teams); expect(v.state).toBe("Approved by Lee Park"); expect(v.buttons).toEqual([{ kind: "open", label: "Open in app", url: "http://x/app/approvals?po=po-1" }]); });
  it("keeps Open in app inside this tab", () => { expect(appPath("http://x/app/approvals?po=po-1")).toBe("/app/approvals?po=po-1"); expect(appPath("bad")).toBe("/app/approvals"); });
});
