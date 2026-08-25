/**
 * The chip is the one place the chosen model is named at rest. A cold reader
 * who has connected nothing must learn it from the chip, not from a send that
 * fails.
 */
import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@pylos/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer, type ComposerProps, modelChipState } from "../src/components/Composer.tsx";

const grok: ModelInfo = {
  id: "grok-4.6",
  provider: "xai",
  label: "Grok 4.6",
  available: true,
  supportsTools: true,
};

function composer(models: ModelInfo[], model: string): string {
  const props: ComposerProps = {
    models,
    model,
    budget: 32768,
    busy: false,
    attachments: [],
    onSend: () => undefined,
    onStop: () => undefined,
    onError: () => undefined,
    onPickModel: () => undefined,
    onConnectModel: () => undefined,
    onEarlier: () => undefined,
    onAttach: () => undefined,
    onRemoveAttachment: () => undefined,
    onBudget: () => undefined,
    onRefreshModels: () => undefined,
  };
  return renderToStaticMarkup(createElement(Composer, props));
}

describe("the model chip states its provider", () => {
  test("an unconnected model carries the suffix and says what a tap does", () => {
    const state = modelChipState({ ...grok, available: false });
    expect(state.connected).toBe(false);
    expect(state.title).toBe("Grok 4.6 is not connected — tap to connect it, or to pick a model that is.");
  });

  test("a connected model reads as ready and still explains the menu", () => {
    const state = modelChipState(grok);
    expect(state.connected).toBe(true);
    expect(state.title).toContain("Tap to switch model");
  });

  test("a model the list does not carry yet claims nothing", () => {
    expect(modelChipState(undefined).connected).toBe(true);
  });

  test("the composer shows the suffix at rest when the provider is not connected", () => {
    const html = composer([{ ...grok, available: false }], grok.id);
    expect(html).toContain("· not connected");
    expect(html).toContain("Grok 4.6 is not connected");
  });

  test("a connected provider leaves the chip unchanged", () => {
    const html = composer([grok], grok.id);
    expect(html).not.toContain("not connected");
    expect(html).toContain("Grok 4.6");
  });
});
