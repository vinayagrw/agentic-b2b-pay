// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../src/lib/api", () => ({
  api: vi.fn(async () => ({})),
  useAct: () => ({ run: async (f: () => any) => f(), busy: false, error: "" }),
  useGet: () => ({ data: [] }),
  useMe: () => ({ data: { user: { id: "usr-controller-sam" }, permissions: ["flow.operate", "payments.approve"] } }),
  useAppState: () => ({ data: null }),
}));
vi.mock("../src/components/ui", async (orig) => {
  const real: any = await orig();
  const Pass = ({ children }: any) => <>{children}</>;
  return { ...real, Menu: Pass, MenuTrigger: Pass, MenuContent: Pass, MenuLabel: Pass, MenuSep: () => null,
    MenuItem: ({ children, onSelect }: any) => <button type="button" onClick={onSelect}>{children}</button> };
});

import { InvoiceTable } from "../src/pages/flows";
import { ViewsMenu } from "../src/components/TableKit";

afterEach(cleanup);
const alerts = () => screen.queryAllByRole("alert").map((a) => a.textContent);

describe("inline form errors clear as soon as the user types", () => {
  it("invoice action form: Add a reason. goes away on the first keystroke", () => {
    const inv = { id: "inv-1", number: "NW-1", poId: "po-1", amount: 10.2, currency: "USD", matchStatus: "exception", submittedBy: "supplier-portal:sup-northwind", paid: false };
    render(<InvoiceTable st={{ invoices: [inv] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Hold" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(alerts()).toContain("Add a reason.");
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "P" } });
    expect(alerts()).not.toContain("Add a reason.");
  });
  it("Name this view: Add a name. goes away on the first keystroke", () => {
    render(<ViewsMenu table={"payments" as any} current={{} as any} onApply={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(alerts()).toContain("Add a name.");
    fireEvent.change(screen.getByLabelText("Name this view"), { target: { value: "M" } });
    expect(alerts()).not.toContain("Add a name.");
  });
});
