# Pylos design system

One line: **baked clay and verdigris.** Understated, engraved, quiet; the
interest comes from typography, motion, and what the interface chooses not to
show. Rounded controls. One accent. Monospace only for evidence.

Reference points: the Hermes Agent site (serif display + mono evidence + one
electric color + generous whitespace) and Revelation's classical futurism — but
Pylos must not be blue. Both references are ultramarine; Pylos is green-bronze
on bone.

## Palette

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bone` | `#F4F1EA` | `#121310` | page / app background |
| `--tablet` | `#EAE5DA` | `#1B1D19` | cards, composer, capsules |
| `--ink` | `#17160F` | `#ECE7DB` | primary text |
| `--ash` | `#7C786E` | `#8E8A80` | secondary text, hairlines at 0.14 alpha |
| `--verdigris` | `#1F6F5C` | `#4FB39A` | accent: links, primary buttons, focus, the seal |
| `--verdigris-deep` | `#164F42` | `#3E9A83` | hover / pressed |
| `--ember` | `#C98A2E` | `#E0A64A` | "recovered" / paged-in glow, live indicator, resident meter |
| `--oxblood` | `#8E2C2C` | `#D26060` | stale · revoked · refused |
| `--hairline` | `rgba(23,22,15,0.12)` | `rgba(236,231,219,0.12)` | borders |

Only one accent is on screen at a time. Ember and oxblood appear only on
evidence states. Never gradients; allow a very faint paper-noise texture on
bone (2–3% opacity) on the landing page only.

## Type

* **Display:** `Newsreader` (variable, optical size) — hero, section heads,
  thread title. Tight leading (0.98–1.05), sentence case.
* **UI:** `Geist` (fallback `Inter`, system-ui). 14.5–15px body, 1.55 leading.
* **Evidence / receipts / counters / code:** `Geist Mono` (fallback `IBM Plex Mono`).
  Uppercase letterspaced (`0.08em`) for small labels — the engraved register.
* Landing only: an enormous Newsreader numeral for "1,000,000".

All fonts self-hosted via `@fontsource` (app) and `/fonts` (landing); Google
Fonts allowed only for the hosted landing.

## Shape & space

* Buttons: pill (`999px`) for primary CTAs; `10px` radius for secondary.
* Cards / composer / capsules: `14px` radius, hairline border, no shadow at rest.
* Base spacing unit 4px; generous vertical rhythm (sections 96–128px on landing).
* Max text measure 68ch in the transcript.

## The app (calm Pylos)

* The window **is** the transcript. Composer pinned at the bottom, rounded,
  with a tiny model chip (`Grok 4.6 ▾`) and a paperclip. Nothing else by default.
* Top edge: the thread title in Newsreader, and at the far right the **seal** —
  a small mono line `archive 12,408 · view 23.1k / 24k · 2 recovered`. The seal
  is the only place the machinery shows. Clicking it opens the **X-ray** drawer.
* Messages: no bubbles. User turns in ink with a thin verdigris left rule;
  assistant turns plain. Timestamps and seq numbers appear on hover only, in
  mono ash.
* **Scrolling is interesting but quiet.** The scrollbar is replaced by a
  thin timeline rail on the right edge: hairline ticks at capsule boundaries
  (denser marks = more compacted); the current viewport is a verdigris thumb;
  handoffs are small ember ticks. Hovering the rail shows the turn number and
  date. Scrolling upward past the loaded window pages older episodes from the
  vault (virtualized) — the user can scroll to turn 1 of a million-turn thread.
* Compaction boundaries inside the transcript: a hairline with a mono caption
  `sealed · turns 1,024–2,047 · 3 losses carried` — visible, never loud.
* Recovery line above an answer: `↺ recovered two earlier moments` in ember
  mono; click to expand the exact spans inline.
* Handoff divider: hairline, `Grok stopped here. Claude continued from the same thread.`
* Motion: 150–220ms ease-out; streaming text appears with no typewriter
  gimmick; the seal's resident meter fills with ember as the packet is built,
  then settles.
* Dark mode follows the system.

## The landing page

Structure (low density, large type, one scroll):

1. Thin nav: wordmark `pylos`, Theory, GitHub, Download.
2. Hero on bone: overline `OPEN SOURCE · APACHE-2.0 · MAC + LINUX`, display
   headline **Talk forever.** (alt: *A conversation that outlives every model.*),
   one sentence, two CTAs — pill **Watch turn 1,000,000** and ghost **Download**.
3. **The aperture** — a live, in-browser run of the real `@pylos/core` compiler
   over a synthetic stream: one counter races toward 1,000,000 turns, the other
   (view tokens) stays flat; a thin ledger strip shows losses being recorded
   and a recovered span lighting up in ember. Ten seconds, no video.
4. Three short statements with mono captions: *The archive is exact.* · *The
   view is bounded.* · *Nothing is forgotten silently.*
5. The trap (from the bench): two columns, same model, same question at turn
   1,000,000 — rolling summary vs Pylos; the baseline follows the stale rule,
   Pylos pages the revision. Real outputs, hash-linked to the bench artifact.
6. Download cards (macOS · Linux) + a copyable install line.
7. Footer: the Pylos line — *The tablets survived because the palace burned.*

OG image: bone background, verdigris wordmark, ember numeral.
