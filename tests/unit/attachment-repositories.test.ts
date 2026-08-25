import { describe, expect, it } from "vitest";
import { attachmentLockStatement } from "../../lib/infrastructure/attachment-repositories";

describe("private attachment authorization locks", () => {
  it("locks the parent requisition and item together before item authorization", () => {
    const statement = attachmentLockStatement("requisicion_item");
    expect(statement).toContain("join requisicion_items ri on ri.requisicion_id=r.id");
    expect(statement).toContain("for update of r, ri");
  });

  it("uses a narrow row lock for the other supported parent entities", () => {
    expect(attachmentLockStatement("requisicion")).toBe("select id from requisiciones where id = $1 for update");
    expect(attachmentLockStatement("caja_menor")).toBe("select id from caja_menor where id = $1 for update");
  });
});
