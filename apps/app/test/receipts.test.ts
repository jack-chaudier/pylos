/**
 * The memory gate writes its qualifications into the assistant's text. The app
 * has to set them apart without editing them: whatever comes back out must be
 * the same bytes the kernel stored, and prose that merely contains brackets is
 * not a receipt.
 */
import { describe, expect, test } from "bun:test";
import { splitReceipts } from "../src/receipts.ts";

const UNKNOWN = "⟨pylos UNKNOWN · no current witnessed archive span supports this remembered assertion⟩";
const HISTORICAL = "⟨pylos HISTORICAL · the cited archive witness has changed⟩";

describe("splitReceipts", () => {
  test("an answer with no receipts is returned untouched", () => {
    const text = "The rule changed on turn 966.\n\nSo the dry-run is not required.\n";
    expect(splitReceipts(text)).toEqual({ body: text, receipts: [] });
  });

  test("the gate's qualification leaves the body and stands on its own", () => {
    const text = `Your dog is called Biscuit.\n\n${UNKNOWN}`;
    expect(splitReceipts(text)).toEqual({
      body: "Your dog is called Biscuit.",
      receipts: [UNKNOWN],
    });
  });

  test("every qualification is pulled out, in the order the kernel wrote them", () => {
    const text = `An answer.\n\n${HISTORICAL}\n${UNKNOWN}`;
    const { body, receipts } = splitReceipts(text);
    expect(body).toBe("An answer.");
    expect(receipts).toEqual([HISTORICAL, UNKNOWN]);
    // Display only: the stored text recomposes exactly from what we render.
    expect(`${body}\n\n${receipts.join("\n")}`).toBe(text);
  });

  test("the paging round's em-dash receipt is one too", () => {
    const line = "⟨UNKNOWN — the archive has no exact material for these⟩";
    expect(splitReceipts(`I could not find it.\n\n${line}`)).toEqual({
      body: "I could not find it.",
      receipts: [line],
    });
  });

  test("a receipt still arriving is a receipt, not body that will jump", () => {
    const partial = "⟨pylos UNKNOWN · no current witnessed";
    expect(splitReceipts(`Your dog is called Biscuit.\n\n${partial}`)).toEqual({
      body: "Your dog is called Biscuit.",
      receipts: [partial],
    });
    // The opening bracket alone, the frame before the classification arrives.
    expect(splitReceipts("Your dog is called Biscuit.\n\n⟨pylos")).toEqual({
      body: "Your dog is called Biscuit.",
      receipts: ["⟨pylos"],
    });
  });

  test("a closed receipt followed by an opening one keeps both apart", () => {
    const text = `An answer.\n\n${HISTORICAL}\n⟨pylos UNKN`;
    expect(splitReceipts(text)).toEqual({
      body: "An answer.",
      receipts: [HISTORICAL, "⟨pylos UNKN"],
    });
  });

  test("a bracketed phrase inside a sentence is the model's prose", () => {
    const text = `The view carried ${UNKNOWN} where the atom should have been.`;
    expect(splitReceipts(text)).toEqual({ body: text, receipts: [] });
  });

  test("an unclosed bracket mid-answer is prose, not a receipt in progress", () => {
    const text = "⟨pylos was the word I could not finish\nand then the sentence went on.";
    expect(splitReceipts(text)).toEqual({ body: text, receipts: [] });
  });

  test("the kernel's check prompt line is not a qualification", () => {
    const text = "⟨pylos check⟩ Your draft states: Boston.";
    expect(splitReceipts(text)).toEqual({ body: text, receipts: [] });
  });

  test("only the blank paragraph the receipts left behind is trimmed", () => {
    expect(splitReceipts(`One.\n\n\nTwo.\n\n${UNKNOWN}`)).toEqual({
      body: "One.\n\n\nTwo.",
      receipts: [UNKNOWN],
    });
  });

  test("a text that is nothing but receipts has no body", () => {
    expect(splitReceipts(`${HISTORICAL}\n${UNKNOWN}`)).toEqual({
      body: "",
      receipts: [HISTORICAL, UNKNOWN],
    });
  });
});
