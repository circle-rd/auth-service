import { describe, expect, it, vi } from "vitest";
import { refreshUserSessionSnapshots } from "./session-snapshot.js";

describe("refreshUserSessionSnapshots", () => {
  it("writes the user through the adapter so live session copies are refreshed", async () => {
    const updateUser = vi.fn(async () => undefined);

    await refreshUserSessionSnapshots({ updateUser }, "user-1");

    expect(updateUser).toHaveBeenCalledTimes(1);
    const [id, data] = updateUser.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe("user-1");
    expect(data.updatedAt).toBeInstanceOf(Date);
  });
});
