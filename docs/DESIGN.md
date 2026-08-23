# Pylos design system

One line: **kiln and bone.** A single fired colour over the whole page, bone
type set large in a high-contrast serif, typewriter mono for everything that
counts, and engravings screened into two colours. The interface is a presence
you talk to, not a scrollback you read. Nothing is decorated; everything is
either evidence or silence.

Reference point: the Hermes Agent site — one electric colour, uppercase serif
display, mono eyebrows, halftoned engravings, a hairline frame inset from the
viewport, a bone panel for the numbered features, a ghost wordmark in the
footer. Pylos takes the form and fires it: the colour is kiln orange, never
blue; the pictures are Doré, Flammarion and the Mnemosyne plate; the subject
is memory, not agency.

## Palette

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--kiln` | `#D9450E` | `#D9450E` | the ground of the landing page; the one accent in the app |
| `--kiln-deep` | `#A92F06` | `#F06A2E` | hover / pressed; rules on kiln |
| `--bone` | `#F4EBDD` | `#140B06` | app ground; the feature panel on the landing; type on kiln |
| `--tablet` | `#EDE2D0` | `#1E120A` | composer, cards, capsules, drawers |
| `--ink` | `#1A1208` | `#F1E7D7` | primary text on bone |
| `--ash` | `#7A6A5A` | `#9C8B78` | secondary text; hairlines at 0.16 alpha |
| `--oxblood` | `#7E1F14` | `#E2674A` | stale · revoked · refused · unverified |
| `--hairline` | `rgba(26,18,8,0.14)` | `rgba(241,231,215,0.14)` | borders on bone |
| `--hairline-kiln` | `rgba(244,235,221,0.28)` | same | borders and frame on kiln |

One accent. On kiln everything is bone; on bone the only colour is kiln.
Oxblood appears only on evidence states. No gradients. A 3% grain over kiln
on the landing page (a tiled noise PNG, not an SVG filter; the CSP forbids
inline styles but not images). Dark mode in the app swaps bone for burnt
ground and keeps kiln; the landing page is kiln in both modes.

## Type

* **Display:** `Instrument Serif` (regular + italic), uppercase, letterspacing
  `-0.01em`, leading 0.9–0.95. Hero 8–11vw; section heads 4–6vw; the
  numeral `1,000,000` as large as the column allows. Italic for the one
  phrase in a headline that carries the feeling.
* **Mono:** `Courier Prime` (regular, bold, italic), uppercase eyebrows and
  labels at `0.12em` letterspacing (`#1 REMEMBER`, `OPEN SOURCE · APACHE-2.0`),
  receipts, counters, the evidence bar, the install line, code. This is the
  engraved register; it is the only voice allowed to state a number.
* **Body:** `Geist` (fallback system-ui) for app prose and answers, 15.5px,
  leading 1.6; on the landing page body copy is Instrument Serif sentence
  case at 1.25–1.5rem, or Courier Prime uppercase for captions under images.

All fonts self-hosted (`apps/web/public/fonts`, `apps/app/public/fonts`),
latin subsets only, preloaded. The `Newsreader` and `@fontsource` files are
retired.

## Imagery

Public-domain engravings, screened to exactly two colours by
`apps/web/scripts/halftone.py`-style processing before they enter the tree
(the tree holds only the finished lossless WebP; sources and the processor
stay out of the repository). Two screens: a 45° dot screen for plates that
carry light (the Empyrean, the firmament), a horizontal line screen for
figures (Mnemosyne, the Ninth Heaven). Bone-on-kiln when the image sits on
the ground; kiln-on-bone when it sits in the feature panel.

| File | Plate | Where |
| --- | --- | --- |
| `art/empyrean.webp` | Doré, *Paradiso* XXXI — two figures before the rings of the Empyrean | hero, right column; the sign-in screen of the app at 22% opacity |
| `art/firmament.webp` | the Flammarion engraving — a head through the firmament | the proof section, behind the chart at 18% |
| `art/mnemosyne.webp` | Mnemosyne, mother of the Muses (Rijksmuseum, CC0) | feature #1 REMEMBER |
| `art/ninth-heaven.webp` | Doré, *Paradiso* XXVIII — two figures at the fixed horizon | feature #2 BOUNDED |
| `art/babel.webp` | Doré, *The Confusion of Tongues* | feature #3 EVERY MODEL |

Credits live in the footer in mono: artist, plate, source, licence. Every
image has empty `alt` when decorative and a real sentence when it carries
meaning.

## Shape & space

* Corners: `2px` on kiln (chips, inputs, cards on the landing page — the
  engraved register is square); `12px` on bone in the app (composer, sheets).
* A hairline-kiln **frame** inset `clamp(10px, 1.4vw, 22px)` from the viewport
  edge on the landing page, fixed, above the content, below the nav.
* Base unit 4px. Landing sections `clamp(6rem, 12vw, 11rem)` apart. Max text
  measure 64ch in answers.
* Buttons: bone block with kiln text on kiln (`PILL → square`, `0.8rem 1.4rem`,
  mono uppercase); on bone, a kiln block with bone text. Ghost variant is a
  hairline box.

## The app — the presence

The app is not a transcript. It is a single composer and a presence that
remembers every word. You talk; it answers; you never scroll up to find
what you said, you ask.

* **The presence.** The centre of the window is a halo: a procedural
  stipple on a canvas — eighteen rings of dots, spacing uniform, each dot
  nudged by a deterministic jitter so the lattice dissolves into tone, the
  weight heaviest in the middle third of the radius and fading at both
  edges like the Empyrean plate — bone on burnt ground in dark mode, kiln
  on bone in light, ~38vmin wide, breathing very slowly (a 9s ease, ±2%
  radius) at rest. It is the archive: angle is position in the thread
  (turn 1 at twelve o'clock, the newest turn just before it), and a dot is
  larger and brighter where the archive is denser; an empty thread is a
  faint, even halo. While a packet is
  built the ring tightens and fills from the inside (the resident meter
  became the ring); while the answer streams the ring is still; when a
  page is served the exact angular position of the recovered turn lights
  for 1.2s and a hairline ray runs from it to the answer. A fault that
  nothing answered leaves a single ash dot at the rim. The ring respects
  `prefers-reduced-motion` (no breathing, state changes cut).
* **The exchange.** Under the ring, one exchange at a time: the question in
  Courier Prime ash, the answer in Geist ink, 64ch. The previous exchange
  is not on screen. `↑` or the mono link `earlier ↑` (lowercase — it is a verb) above the question opens
  the **archive drawer** — the virtualised transcript with the timeline
  rail, full height, from the right; it is a place you visit, not where you
  live. The title bar keeps the thread title in Instrument Serif.
* **Recovery lines** sit between question and answer in kiln mono:
  `↺ recovered two earlier moments · turns 1 and 966` (click: the exact
  spans, inline; `turns 1, 966 and 4 more` beyond three);
  `↺ page fault · recovered one earlier moment · turn 61,234 · recall`;
  `· by way of turn 61,234`
  for a path recovery; a fault nothing answered writes no line — the model's
  own sentence stands and the X-ray carries the receipt. The check round
  renders as before: `↺ reopened the archive · names`, oxblood when it could
  not complete.
* **The evidence bar** is a mono ring of figures around the presence at
  rest — `archive 1,204,118 turns` at the top, `view 7.9k / 32k` right,
  `recovered 3` left, `chain ✓` bottom — each a hover title; it collapses to
  one line under 720px. Clicking any figure opens the **X-ray** drawer
  ("What the model saw"), unchanged in content.
* **The composer** is pinned to the bottom: a bone/tablet block, 12px
  corners, a hairline, the model chip (`GROK 4.6 ▾`, mono), a paperclip, a
  send glyph. The model menu lists **connected** providers' models first,
  selectable; models whose provider is not connected are listed under a
  mono rule `connect ▸` and choosing one opens the Connect sheet instead of
  switching. A switch appends the handoff only once the next turn runs.
* **Sign-in** (hosted) and **Connect** (local) share one screen: the
  Empyrean plate at low opacity, the wordmark, one line — *One conversation.
  Every model. Nothing forgotten silently.* — and the buttons: **Sign in
  with xAI** (device code in mono, `Open x.ai`, quiet polling that survives
  a transient error), **Use an API key**, **Import Grok CLI login**. Errors
  read in oxblood mono and never end the flow by themselves.
* Handoff: `Grok stopped here. Claude continued from the same thread.` as a
  hairline line in the archive drawer; in the presence, the ring flickers
  once.
* Motion 150–220ms ease-out; streaming text has no typewriter gimmick.
* Dark mode follows the system. Under 720px the ring shrinks to 30vmin and
  sits above the exchange; the composer stays pinned.

## The landing page

Kiln ground edge to edge, one scroll, the frame inset. Structure:

1. **Nav** (mono, uppercase, bone): wordmark `PYLOS`, `THEORY · GITHUB ·
   INSTALL`, and a bone block `ASK THE THREAD` → `#console`.
2. **Hero**: eyebrow `OPEN SOURCE · APACHE-2.0 · MACOS + LINUX`; display
   `THE CONVERSATION / THAT DOES NOT END`; one serif sentence — *One thread.
   Every model. A million turns deep — ask about anything you ever said and
   the exact words come back.*; a bone block **ASK THE MILLION-TURN THREAD**
   (→ `#console`), a ghost **INSTALL**, and the mono line
   `curl -fsSL https://pylos.vercel.app/install.sh | bash` with a copy
   control. Right column: the Empyrean plate, bleeding past the frame.
3. **The story** — the trap from the live bench, told in plain words with no
   vocabulary, four beats on one screen: turn 1 *"Rule: never send a
   production migration before the dry-run database is verified."*; turn 966
   *"…unless the change is additive-only and the dry-run was skipped by the
   on-call lead."*; a mono counter `966 → 1,000,000 turns later`; the
   question; and two answer blocks side by side — *an ordinary chat
   (rolling summary)* answering from the stale rule, marked `wrong · the
   rule changed on turn 966` in oxblood, and *Pylos* answering from the
   revision, marked `turn 966 · brought back exactly`. The recorded answers,
   probe counts (`5/36` vs `36/36`) and hashes come from `bench/trap.json`;
   the caption names it a live sample at turn 2,000, not a benchmark.
4. **The features** — a bone panel inset from the frame, three columns,
   each an eyebrow, a display head, a kiln-on-bone plate, a mono caption:
   `#1 REMEMBER · ASK, DON'T SCROLL` — *every turn is kept exactly and hashed
   into a chain; ask for turn 61,234 or for where Esme Whitlock lives now and the
   bytes come back* ; `#2 BOUNDED · THE VIEW NEVER GROWS`
   — *the model reads a fixed budget no matter how long the thread is; what
   the budget could not hold is written to a ledger, never dropped in
   silence* ; `#3 EVERY MODEL · ONE THREAD` — *Grok stops, Claude continues,
   a local model finishes; the thread is the agent, the model is the
   visitor.*
5. **The proof** — display `1,000,000 TURNS. / THE VIEW NEVER GREW.` and the
   chart: x is turns 0 → 1,000,000 at the bench's 100 checkpoints; a bone
   area climbing to **1.05 GB** of archive; a flat bone line at the view
   (~7.9k tokens) under a dashed hairline at the cap 8,192 — the caption
   concedes that a summary is flat too; flatness is the table stakes.
   Beneath it the panel that is the claim — *what can still be brought
   back, exactly, at each checkpoint* — Pylos flat at 100% across every
   planted family, the rolling summary falling to 26%, BM25 to 6%. Drawn as
   SVG from `public/bench/series.json` (derived deterministically from
   `bench/results/million-5.json` at build). Under it, a mono receipt row:
   `2,000/2,000 facts · 200/200 quotes exact · 10,000/10,000 turn numbers ·
   2,000/2,000 name-free memories · 2,000/2,000 faults receipted · chain ✓
   to #1,000,000` — every figure a link to the artifact. The Flammarion
   plate sits behind at low opacity.
6. **The aperture** — the live in-browser run of the real compiler (counter
   racing to 1,000,000, view flat, the ledger strip, the recovered span) —
   restyled, unchanged in mechanics and hooks, with a one-line gloss for
   each term it must use (capsule, ledger, frontier, page, certificate,
   packet) the first time it appears, and one sentence naming that the
   browser subset's ledger and byte counts are smaller than the full
   kernel's bench because it keeps no vault and no index.
7. **Ask the thread** (`#console`) — the console: one input, mono chips, the
   answer cards; each chip's label is exactly the text it submits. A
   person can be asked for by any part of the name, lower case included;
   an ambiguous part answers with the candidates, not a miss. A question
   about the world (no cue that refers back) is
   answered with a card headed `⟦not a memory⟧` — *the thread has no turn
   about that; a model would answer from the world* — and is not a fault.
   A question that refers back and reaches nothing is the fault card. The
   visitor can also *tell* the thread something — `remember: my dog is
   called Biscuit` appends turn 1,000,001 to the in-browser archive — and
   then ask for it back; the card reads `⟦recovered #1,000,001 · lexical⟧`
   and the visitor has put their own fact into a million-turn thread.
8. **Install** — `DOWNLOAD PYLOS DESKTOP` (macOS, Apple silicon; Linux x64)
   and `INSTALL VIA TERMINAL` with the curl line; the three-step run; the
   self-host note. Only platforms the release actually builds are named.
9. **Footer** — *THE TABLETS SURVIVED BECAUSE THE PALACE BURNED.* in display,
   the credits row, version and licence, and the ghost wordmark `PYLOS`
   in kiln-deep across the bottom.

OG image: kiln ground, bone `PYLOS`, the Empyrean plate at the right.
