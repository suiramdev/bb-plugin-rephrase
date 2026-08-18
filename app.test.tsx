// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "./server";
import type { ModelChoice } from "./lib/models";

const THREAD_SCOPE = { kind: "thread", threadId: "thr_1" } as const;

const CHOICES: ModelChoice[] = [
  {
    providerId: "claude-code",
    providerName: "Claude Code",
    model: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    description: "Balanced",
    extra: false,
  },
  {
    providerId: "claude-code",
    providerName: "Claude Code",
    model: "claude-opus-5",
    label: "Opus 5",
    description: "Most capable",
    extra: false,
  },
  {
    providerId: "claude-code",
    providerName: "Claude Code",
    model: "claude-haiku-4-5",
    label: "Haiku 4.5",
    description: "Older, small",
    extra: true,
  },
  {
    providerId: "codex",
    providerName: "Codex",
    model: "gpt-5.5",
    label: "5.5",
    description: "OpenAI flagship",
    extra: false,
  },
];

// renderSlot mounts into the document; nothing unmounts it for us.
afterEach(cleanup);

/** Contract-complete handlers so a test only states what it cares about. */
function rpcHandlers(
  overrides: Partial<PluginRpcTestHandlers<typeof rpcContract>> = {},
): PluginRpcTestHandlers<typeof rpcContract> {
  return {
    rephrase: () => ({ ok: true, text: "Rewritten." }),
    catalog: () => ({ selection: null, choices: CHOICES, unavailable: [] }),
    selectAgent: ({ selection }) => ({ selection }),
    ...overrides,
  };
}

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
        rpc: rpcHandlers({
          rephrase: () => ({ ok: true, text: "Improve the login flow." }),
        }),
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
        rpc: rpcHandlers({
          rephrase: () => ({ ok: false, error: "The agent stopped." }),
        }),
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
      { composer: { text: "", scope: THREAD_SCOPE }, rpc: rpcHandlers() },
    );

    const button = slot.getByRole("button", { name: "Re-phrase prompt" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });
});

/** The agent picker, mounted and past its catalogue load. */
async function renderPicker(
  handlers: Partial<PluginRpcTestHandlers<typeof rpcContract>> = {},
): Promise<RenderedSlot> {
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot<Record<string, never>, typeof rpcContract>(
    app.settingsSections[0]!,
    {},
    { rpc: rpcHandlers(handlers) },
  );
  await slot.findByRole("textbox", { name: "Search models" });
  return slot;
}

function search(slot: RenderedSlot, query: string) {
  fireEvent.change(slot.getByRole("textbox", { name: "Search models" }), {
    target: { value: query },
  });
}

describe("agent picker", () => {
  it("lists the default models under their agent and follows the prompt input", async () => {
    const slot = await renderPicker();

    expect(slot.getByText("Claude Code")).toBeDefined();
    expect(slot.getByText("Codex")).toBeDefined();
    expect(slot.getByText("Sonnet 4.6")).toBeDefined();
    expect(slot.getByText("5.5")).toBeDefined();
    // Models the prompt input keeps behind "More models" stay hidden here too.
    expect(slot.queryByText("Haiku 4.5")).toBeNull();

    const defaultRow = slot.getByRole("button", {
      name: /The agent selected in the prompt input/,
    });
    expect(defaultRow.getAttribute("aria-pressed")).toBe("true");
  });

  it("filters to what is typed, including models hidden from the default list", async () => {
    const slot = await renderPicker();

    search(slot, "haiku");
    expect(slot.getByText("Haiku 4.5")).toBeDefined();
    expect(slot.queryByText("Sonnet 4.6")).toBeNull();

    // Fuzzy, like the prompt input: "gpt55" reaches "gpt-5.5".
    search(slot, "gpt55");
    expect(slot.getByText("5.5")).toBeDefined();
    expect(slot.queryByText("Opus 5")).toBeNull();

    search(slot, "");
    expect(slot.getByText("Sonnet 4.6")).toBeDefined();
    expect(slot.queryByText("Haiku 4.5")).toBeNull();
  });

  it("says so when nothing matches", async () => {
    const slot = await renderPicker();

    search(slot, "zzzz");
    expect(slot.getByText("No models match your search.")).toBeDefined();
  });

  it("saves the picked model and marks it", async () => {
    const slot = await renderPicker();

    fireEvent.click(slot.getByRole("button", { name: /Opus 5/ }));

    await waitFor(() => {
      expect(
        slot.getByRole("button", { name: /Opus 5/ }).getAttribute("aria-pressed"),
      ).toBe("true");
    });
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "selectAgent",
      input: { selection: { providerId: "claude-code", model: "claude-opus-5" } },
    });
  });

  it("still shows a picked model the catalogue stopped listing", async () => {
    const slot = await renderPicker({
      catalog: () => ({
        selection: { providerId: "codex", model: "gpt-legacy" },
        choices: CHOICES,
        unavailable: ["Gemini"],
      }),
    });

    expect(
      slot.getByRole("button", { name: /gpt-legacy/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(slot.getByText(/No models from Gemini/)).toBeDefined();
  });

  it("reports a catalogue that could not be read", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot<Record<string, never>, typeof rpcContract>(
      app.settingsSections[0]!,
      {},
      {
        rpc: rpcHandlers({
          catalog: () => {
            throw new Error("No agents are signed in.");
          },
        }),
      },
    );

    await slot.findByText("No agents are signed in.");
    expect(slot.getByRole("button", { name: "Try again" })).toBeDefined();
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
