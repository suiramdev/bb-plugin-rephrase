// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "./server";

const THREAD_SCOPE = { kind: "thread", threadId: "thr_1" } as const;

// renderSlot mounts into the document; nothing unmounts it for us.
afterEach(cleanup);

/** The registered customization plus the action component it contributes. */
async function actionRegistration() {
  const app = await loadPluginApp(() => import("./app"));
  const customization = app.composerCustomizations[0]!;
  return { customization, action: customization.actions![0]! };
}

describe("re-phrase composer action", () => {
  it("sends the draft with its composer scope and writes the answer back", async () => {
    const { action } = await actionRegistration();
    const slot = renderSlot<Record<string, never>, typeof rpcContract>(
      action,
      {},
      {
        composer: { text: "make login better plz", scope: THREAD_SCOPE },
        rpc: { rephrase: () => ({ ok: true, text: "Improve the login flow." }) },
      },
    );

    fireEvent.click(slot.getByRole("button", { name: "Re-phrase prompt" }));

    await waitFor(() => {
      expect(slot.inspection.composer.text).toBe("Improve the login flow.");
    });
    expect(slot.inspection.rpcCalls).toEqual([
      {
        method: "rephrase",
        input: { text: "make login better plz", scope: THREAD_SCOPE },
      },
    ]);
    // The draft is locked and dimmed while the agent works, then released.
    expect(slot.inspection.composer.inputLockCalls).toEqual([true, false, false]);
    expect(slot.inspection.composer.inputLocked).toBe(false);
    expect(slot.inspection.composer.textEffect).toBeNull();
    expect(slot.inspection.composer.focusCount).toBe(1);
  });

  it("keeps the draft when the agent could not rephrase it", async () => {
    const { action } = await actionRegistration();
    const slot = renderSlot<Record<string, never>, typeof rpcContract>(
      action,
      {},
      {
        composer: { text: "fix tests", scope: THREAD_SCOPE },
        rpc: { rephrase: () => ({ ok: false, error: "The agent stopped." }) },
      },
    );

    fireEvent.click(slot.getByRole("button", { name: "Re-phrase prompt" }));

    await waitFor(() => {
      expect(slot.inspection.composer.inputLocked).toBe(false);
    });
    expect(slot.inspection.composer.text).toBe("fix tests");
    expect(slot.inspection.composer.textEffect).toBeNull();
  });

  it("stays disabled while the draft is empty", async () => {
    const { action } = await actionRegistration();
    const slot = renderSlot<Record<string, never>, typeof rpcContract>(
      action,
      {},
      { composer: { text: "", scope: THREAD_SCOPE } },
    );

    const button = slot.getByRole("button", { name: "Re-phrase prompt" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});

describe("registrations", () => {
  it("offers the same command in the composer's plus menu", async () => {
    const { customization } = await actionRegistration();
    const item = customization.plusMenu![0]!;

    expect(item.label).toBe("Re-phrase prompt");
    expect(
      typeof item.disabled === "function"
        ? item.disabled({
            scope: THREAD_SCOPE,
            layout: "compact",
            draft: { text: "", isEmpty: true, attachmentCount: 0 },
            run: { isRunning: false, isSubmitting: false },
          })
        : item.disabled,
    ).toBe(true);
  });

  it("applies to every composer kind", async () => {
    const { customization } = await actionRegistration();
    expect(customization.scopes).toBeUndefined();
  });
});
