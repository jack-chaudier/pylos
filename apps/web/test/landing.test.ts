import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PERSON_PROBE } from "../src/aperture/console";

const root = new URL("../", import.meta.url);
const landing = readFileSync(new URL("index.html", root), "utf8");
const styles = readFileSync(new URL("src/styles.css", root), "utf8");

/** The page is hand-formatted HTML; assertions read it as one line of prose. */
const flat = landing.replace(/\s+/g, " ");

const natural = JSON.parse(readFileSync(new URL("../../bench/results/natural.json", root), "utf8")) as {
  metrics: {
    attempted: number;
    semanticHits: number;
    falsePages: { count: number; denominator: number };
  };
};

/** The tracked tree only: build output and node_modules are not the source. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|html|css|json|webmanifest|sh)$/.test(entry)) out.push(path);
  }
  return out;
}

describe("the landing copy", () => {
  test("the hero states the claim in plain words", () => {
    expect(flat).toContain(
      "One thread. Every model. A million turns deep, and the exact words come back — with a " +
        "receipt for everything the model's view left out.",
    );
    // no vocabulary before the exhibit earns it
    expect(flat).not.toContain("the bounded view left out");
    expect(flat).toContain("Open source · Apache-2.0 · macOS + Linux");
    expect(flat).toContain("Ask the million-turn thread");
    // the lede stands on its own: no turn number the reader has not met
    expect(flat).not.toContain("hands you the exact words from turn 345");
    // the hedging chip the v2 draft hung on the lede is gone
    expect(landing).not.toContain("hero__fixture-note");
    expect(styles).not.toContain("hero__fixture-note");
  });

  test("plain words come first and the term follows, at its first use", () => {
    // the six-noun homework strip is gone
    expect(flat).not.toContain("what is currently true, as certificates");
    expect(flat).not.toContain("the bounded text the model reads");
    expect(flat).toContain(
      "Plain words first. The word after each dot is what Pylos calls it — hover a marked term " +
        "for the whole definition.",
    );

    const glossed: [string, string][] = [
      ["archive", "Every turn, kept exactly · "],
      ["packet", "What the model reads · "],
      ["frontier", "the facts currently standing · "],
      ["capsules", "summaries of older turns · "],
      ["paged", "fetched back for this question · "],
      ["ledger", "What the summaries dropped, with a way back to it · "],
      ["certificate", "a fact you stated and the kernel still holds true — a "],
    ];
    for (const [term, plain] of glossed) {
      expect(flat).toContain(`${plain}<dfn`);
      expect(flat).toContain(`>${term}</dfn`);
    }
    // every marked term carries its whole definition as a tooltip, and nothing else does
    expect(landing.match(/<dfn\s+title="/g) ?? []).toHaveLength(glossed.length);
    expect(landing.match(/<dfn/g) ?? []).toHaveLength(glossed.length);
    // the frontier is defined without leaning on another unexplained word
    expect(flat).toContain(
      "The frontier is the facts currently standing — the rules you set and the newest value of " +
        "every fact — each one tied to the turn that stated it, and carried whatever their age.",
    );
  });

  test("the aperture names what it is doing instead of showing zeros", () => {
    expect(flat).toContain("Waking the million-turn archive…");
    expect(flat).toContain("waiting for the first summary to seal");
    expect(flat).toContain('<strong class="counter" data-ap-archive aria-live="off">—</strong>');
    expect(flat).toContain("Ready · the same numbers every run (seed 1)");
    // the level ladder and the fan-out are glossed where they are shown
    expect(flat).toContain(
      "Summaries of summaries, coarsest lane at the top down to the raw turns at the bottom " +
        "(level 4 → level 0) · the full-height mark is turn 483,112, where the rule changed",
    );
  });

  test("the console note tells the two kinds of miss apart in plain words", () => {
    expect(flat).toContain(
      "A question about the world — one that never reaches back into this conversation — gets " +
        "<code>⟦no turn about that · not a memory⟧</code>: the thread has no turn on the subject, " +
        "and a model would answer it from what it knows.",
    );
    expect(flat).toContain(
      "A question that does reach back into the conversation, and reaches no turn, gets " +
        "<code>⟦looked back, found no route to a turn · page fault⟧</code>, and that one is " +
        "receipted as a failure.",
    );
  });

  test("the three features say what they do", () => {
    expect(flat).toContain(
      "Every turn is kept exactly and hashed into a chain. Ask for turn 61,234, or for what Esme " +
        "Whitlock said — a name planted deep in the million-turn thread you can question further " +
        "down this page — and the bytes come back, not a paraphrase.",
    );
    // she is introduced where she is first named, and paid off in the console
    expect(flat.indexOf("a name planted deep in the million-turn thread")).toBeLessThan(
      flat.indexOf("the name from the first card at the top of this page"),
    );
    expect(flat).toContain(
      `${PERSON_PROBE.person}, the name from the first card at the top of this page, is one of the ` +
        "people in this thread; the chips below ask about her.",
    );
    expect(flat).toContain(
      "The model reads a fixed budget whether the thread is ten turns or a million. Whatever the budget cannot hold is written to a ledger with an address, never dropped in silence.",
    );
    expect(flat).toContain(
      "Grok stops, Claude continues, a local model finishes. The thread is the agent; the model is the visitor.",
    );
  });

  test("nothing on the page steps over the claim boundary", () => {
    for (const banned of ["never forgets", "cannot be wrong", "ask about anything you ever said"]) {
      expect(flat.toLowerCase()).not.toContain(banned);
    }
  });
});

describe("what is proven, what is not", () => {
  test("the block sits after the chart and before the aperture", () => {
    expect(landing.indexOf('class="boundary"')).toBeGreaterThan(landing.indexOf('class="proof"'));
    expect(landing.indexOf('class="boundary"')).toBeLessThan(landing.indexOf('class="aperture"'));
    expect(flat).toContain("What is proven, what is not");
    expect(flat).toContain(">Proven</p>");
    expect(flat).toContain(">Experimental</p>");
    expect(flat).toContain(">Not claimed</p>");
    expect(flat).toContain("Read the receipts");
    expect(flat).toContain("https://github.com/jack-chaudier/pylos/tree/main/bench/results");
  });

  test("the experimental figures are the ones the natural bench recorded", () => {
    const { semanticHits, attempted, falsePages } = natural.metrics;
    expect(flat).toContain(`chose the intended source ${semanticHits} of ${attempted} times`);
    expect(flat).toContain(`a wrong one ${falsePages.count} of ${falsePages.denominator}`);
    expect(flat).toContain(
      `Natural-question receipt · ${semanticHits} of ${attempted} intended sources · ` +
        `${falsePages.count} of ${falsePages.denominator} wrong ones`,
    );
  });

  test("proven names the run, not a promise", () => {
    expect(flat).toContain(
      "Exact recall by address. 1,000,000 turns, every planted fact, quote, number and turn reference recovered at the final checkpoint. Chain verified.",
    );
    expect(flat).toContain(
      "That any phrasing will find its source, that the model's answers are correct, or any number we have not measured.",
    );
  });
});

describe("the nav", () => {
  test("carries the mark and the counted pulse", () => {
    expect(flat).toContain('<span class="mark" aria-hidden="true"');
    expect(flat).toContain('<img src="/art/empyrean.webp"');
    expect(flat).toContain('class="mono nav__pulse"');
    expect(flat).toContain(
      '<span class="nav__dot" aria-hidden="true"></span><span class="nav__tag">Our proof run</span>' +
        '<span data-nav-count>1,000,000</span><span class="nav__long"> turns · chain</span> ✓',
    );
    // the capsule says whose number it is, and what it is a number of
    expect(flat).toContain(
      'title="The counter replays the deterministic 1,000,000-turn bench · chain verified — ' +
        'bench/results/million-6.md"',
    );
    expect(styles).toMatch(/\.nav__tag\s*\{[^}]*opacity:\s*0\.72/s);
    expect(styles).toMatch(/\.mark\s*\{[^}]*width:\s*44px/s);
    expect(styles).toMatch(/\.mark\s*\{[^}]*animation:\s*mark-turn 120s linear infinite/s);
    expect(styles).toContain("@keyframes mark-turn");
    expect(styles).toMatch(/\.wordmark:hover \.mark\s*\{[^}]*animation-duration:\s*20s/s);
    expect(styles).toMatch(/\.nav\[data-scrolled="true"\] \.nav__bar/);
  });

  test("the pulse is an engraved capsule with a breathing dot", () => {
    expect(styles).toMatch(/\.nav__pulse\s*\{[^}]*border:\s*1px solid var\(--hairline-kiln\)/s);
    expect(styles).toMatch(/\.nav__pulse\s*\{[^}]*border-radius:\s*var\(--corner\)/s);
    expect(styles).toMatch(/\.nav__pulse\s*\{[^}]*font-variant-numeric:\s*tabular-nums/s);
    expect(styles).toMatch(/\.nav__dot\s*\{[^}]*animation:\s*pulse-breathe/s);
    expect(styles).toContain("@keyframes pulse-breathe");
  });

  test("the bar lives inside the frame and the wordmark has somewhere to go", () => {
    expect(flat).toContain('<div class="nav__bar">');
    expect(styles).toMatch(/\.nav\s*\{[^}]*padding:\s*var\(--inset\) var\(--inset\) 0/s);
    // the frame draws the bar's top edge, so it sits above the nav
    const frame = /\.frame\s*\{[^}]*z-index:\s*(\d+)/s.exec(styles)?.[1];
    const nav = /\.nav\s*\{[^}]*z-index:\s*(\d+)/s.exec(styles)?.[1];
    expect(Number(frame)).toBeGreaterThan(Number(nav));
    expect(flat).toContain('href="#top"');
    expect(flat).toContain('<section class="hero" id="top">');
  });

  test("the label survives the collapse the words do not", () => {
    const block = (w: number): string =>
      new RegExp(`@media \\(max-width: ${w}px\\) \\{(.*?)\\n\\}`, "s").exec(styles)?.[1] ?? "";
    expect(block(1000)).not.toContain(".nav__tag");
  });

  test("the pulse collapses to the figure rather than disappearing on a tablet", () => {
    const block = (w: number): string =>
      new RegExp(`@media \\(max-width: ${w}px\\) \\{(.*?)\\n\\}`, "s").exec(styles)?.[1] ?? "";
    expect(block(1000)).toMatch(/\.nav__long\s*\{\s*display:\s*none/);
    // the capsule itself survives every width the words do not
    expect(block(1000)).not.toContain(".nav__pulse");
    expect(block(860)).not.toContain(".nav__pulse");
  });

  test("the invitations are pills and the engraved register stays square", () => {
    expect(styles).toContain("--pill: 999px");
    expect(styles).toContain("--corner: 2px");
    expect(styles).toMatch(/\.btn--bone,\s*\.btn--ghost\s*\{[^}]*border-radius:\s*var\(--pill\)/s);
    expect(styles).toMatch(/\.btn:hover \.btn__arrow[^{]*\{[^}]*translateX\(3px\)/s);
    expect(styles).toMatch(/\.console__input\s*\{[^}]*border-radius:\s*var\(--corner\)/s);
  });

  test("every control answers the pointer", () => {
    // the ghost inverts: bone ground, kiln type
    expect(styles).toMatch(
      /\.btn--ghost:hover\s*\{[^}]*background:\s*var\(--bone\)[^}]*color:\s*var\(--kiln\)/s,
    );
    // the quiet controls and the ask chips take a bone wash and a 1px press
    expect(styles).toMatch(/\.btn--quiet:hover\s*\{[^}]*background:\s*rgba\(244, 235, 221, 0\.12\)/s);
    expect(styles).toMatch(/\.btn--quiet:active\s*\{[^}]*translateY\(1px\)/s);
    expect(styles).toMatch(/\.ask:hover\s*\{[^}]*background:\s*rgba\(244, 235, 221, 0\.12\)/s);
    expect(styles).toMatch(/\.ask:active\s*\{[^}]*translateY\(1px\)/s);
    // the install card slides its own download arrow
    expect(styles).toMatch(/\.card:hover \.btn__arrow/);
    // the nav links draw a bone rule in from the left
    expect(styles).toMatch(/\.nav__links > a:not\(\.btn\)\s*\{[^}]*background-size:\s*0 1px/s);
    expect(styles).toMatch(/background-size:\s*100% 1px/);
  });
});

describe("install", () => {
  test("points at the v2.0.0 release assets by name", () => {
    expect(flat).toContain("Install · v2.0.0 · Apache-2.0");
    expect(flat).toContain("pylos-2.0.0.dmg");
    expect(flat).toContain("pylos-2.0.0.deb");
    expect(flat).toContain("https://github.com/jack-chaudier/pylos/releases/latest/download/pylos-2.0.0.dmg");
    expect(flat).toContain("Pylos v2.0.0</li>");
    // the source-build hedging of the v2 draft is gone
    expect(flat).not.toContain("Build from source");
    expect(flat).not.toContain("Local preview");
  });
});

describe("icons", () => {
  test("every declared icon is a file on disk", () => {
    for (const href of ["/favicon.ico", "/favicon-32.png", "/favicon-192.png", "/apple-touch-icon.png"]) {
      expect(flat).toContain(`href="${href}"`);
      expect(existsSync(new URL(`public${href}`, root))).toBe(true);
    }
    expect(flat).toContain('<link rel="icon" href="/favicon.ico" sizes="48x48" />');
    expect(existsSync(new URL("public/favicon-512.png", root))).toBe(true);
  });

  test("the ico carries 16, 32 and 48 as PNGs", () => {
    const ico = readFileSync(new URL("public/favicon.ico", root));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
    const sizes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const at = 6 + 16 * i;
      const offset = ico.readUInt32LE(at + 12);
      // each entry is a whole PNG: the eight-byte signature, then IHDR's width
      expect(ico.subarray(offset, offset + 8).toString("hex")).toBe("89504e470d0a1a0a");
      sizes.push(ico.readUInt32BE(offset + 16));
      expect(ico.readUInt8(at)).toBe(sizes[i] as number);
    }
    expect(sizes).toEqual([16, 32, 48]);
  });

  test("the icons are marks, not photographs", () => {
    // a procedural two-colour mark stays small; the plate crop it replaced did not
    const bytes = (name: string): number => statSync(new URL(`public/${name}`, root)).size;
    expect(bytes("favicon-512.png")).toBeLessThan(60_000);
    expect(bytes("favicon-192.png")).toBeLessThan(30_000);
    expect(bytes("apple-touch-icon.png")).toBeLessThan(30_000);
    expect(bytes("favicon-32.png")).toBeLessThan(4_000);
  });

  test("no favicon.svg survives anywhere in apps/web", () => {
    expect(existsSync(new URL("public/favicon.svg", root))).toBe(false);
    const tracked = ["src", "scripts", "public"].flatMap((dir) =>
      sourceFiles(fileURLToPath(new URL(dir, root))),
    );
    expect(tracked.length).toBeGreaterThan(10);
    for (const file of [...tracked, fileURLToPath(new URL("index.html", root))]) {
      expect(readFileSync(file, "utf8")).not.toContain("favicon.svg");
    }
  });
});
