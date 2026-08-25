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

The Empyrean plate is also the site of every mark: the nav mark and the
app's title-bar mark (the plate cropped to its bright core inside a
bone-ringed disc), the app's presence backdrop (`.presence-stage::before`,
~10% opacity at rest, rising to ~14% while the thread is empty — 11%/15% on
burnt ground — radially masked away before it has an edge), and the desktop
app icon. The favicon set (`favicon.ico`, `favicon-32.png`,
`favicon-192.png`, `favicon-512.png`, `apple-touch-icon.png`; `favicon.svg`
is retired) is no longer a crop of the plate — it is a procedural two-colour
mark generated headless outside the tree: a bone-ringed disc on kiln, a
bright core, a radial burst (16 rays at ≥64px, 8 at 17–63px, 4 at 16px), and
a 32-dot screen ring at ≥128px; `favicon.ico` carries the 16, 32 and 48px
sizes. The firmament plate
is also the band behind the app's archive-drawer header, at 8% opacity. A 3%
grain tile (`art/grain.png`) now runs over the app ground as it does over
the landing page's kiln.

## Shape & space

* Two registers, on both surfaces. The **engraved register is square**
  (`--corner: 2px` on the landing page): chips, inputs, the command line,
  cards, tags, and the copy/replay/ask controls. The **invitations are
  round** (`--pill: 999px`): `.btn--bone` and `.btn--ghost` — the nav CTA,
  the hero CTAs, the console's Ask button, the install cards' download
  buttons — padded `0.85rem 1.6rem`, mono uppercase, a soft halo on hover, a
  1px press on `:active`, and a trailing `→` that moves 3px toward the edge
  on hover. Every control answers the pointer: `.btn--ghost` inverts on
  hover (bone ground, kiln type, the page turning inside out under it); the
  square register — `.btn--quiet`, the `.ask` chips — takes a 12% bone wash,
  a bone border, and the same 1px press; the `→` slide also fires from
  `.link` and `.card` hovers, not only buttons.
* In the app the same split runs at app scale: `--corner: 20px` (composer,
  sheets, menus, drawers, banners, the proof-tour shell) and
  `--corner-sm: 12px` (chips, figures, the thread title, icon buttons, the
  model chip, menu items, inputs); send, the mic, and the evidence-bar
  legend dots are circles. The app carries the invitation register too:
  `.pill` and `.ghost` are true pills (`--pill: 999px`). The archive
  drawer's leading corners are rounded to `--corner` — a sheet laid over the
  presence, not a wall.
* A hairline-kiln **frame** inset `clamp(10px, 1.4vw, 22px)` from the
  viewport edge on the landing page, fixed, above everything including the
  nav (`z-index: 31`); the nav bar is inset to the same clamp, so the frame
  draws the bar's top edge and its two ends and the rectangle is never
  broken.
* Base unit 4px. Landing sections `clamp(6rem, 12vw, 11rem)` apart. Max text
  measure 64ch in answers.
* A marked-term register, `dfn`: bold, a dashed hairline-kiln underline, and
  `cursor: help`, used where a sentence cannot avoid a term the page defines
  elsewhere (the aperture's seven glossed terms, `certificate` in the
  console's lede). Plain words carry the sentence; the term is marked after
  them; the full definition rides as the element's `title`. Distinct from
  `.link`, which carries a solid hairline-kiln rule and points off the page.

## The app — the presence

The app is not a transcript. It is a single composer and a presence that
retains stored turns while supported routes address the words you ask for.
You talk; it answers; you never scroll up to find what you said, you ask —
when the kernel can locate the source, it shows the route and receipt.

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
  for 1.2s and a hairline ray runs from it to the answer. A fault with no
  route resolved leaves a single ash dot at the rim. The ring respects
  `prefers-reduced-motion` (no breathing, state changes cut).
* **The exchange.** Under the ring, one exchange at a time: the question in
  Courier Prime ash, the answer in Geist ink, 64ch. The previous exchange
  is not on screen. `↑` or the mono link `earlier ↑` (lowercase — it is a verb) above the question opens
  the **archive drawer** — the virtualised transcript with the timeline
  rail, full height, from the right; it is a place you visit, not where you
  live. The title bar carries the mark, then the thread title in Instrument
  Serif.
* **Recovery lines** sit between question and answer in kiln mono:
  `↺ recovered two earlier moments · turns 1 and 966` (click: the exact
  spans, inline; `turns 1, 966 and 4 more` beyond three);
  `↺ page fault · recovered one earlier moment · turn 61,234 · recall`;
  `· by way of turn 61,234`
  for a path recovery; a fault with no resolved route writes no recovery line —
  the model's own sentence stands and the X-ray carries the routing receipt.
  The check round
  renders as before: `↺ reopened the archive · names`, oxblood when it could
  not complete.
* **The evidence bar** is a mono ring of figures around the presence at
  rest — `archive 1,204,118 turns` at the top, `view 7.9k / 32k` right,
  `paged 3` left, `chain ✓` bottom. Each figure carries a plain-sentence
  title and a matching `aria-label` naming what it measures and that
  clicking opens the X-ray — including the states before a first turn is
  sent (`view — / 32.8K`, `chain —`), which say plainly that nothing has
  been compiled or verified yet rather than leaving the dash to read as a
  fault (`apps/app/src/components/Evidence.tsx`, `figureHints`). It
  collapses to one line under 720px. Clicking any figure opens the
  **X-ray** drawer ("What the model saw"), unchanged in content.
* **The composer** is pinned to the bottom: a bone/tablet block, `--corner`
  16px, a hairline, one row — paperclip, the model chip (`GROK 4.6 ▾`,
  mono), a mic, and the send circle. When the selected model's provider
  holds no credentials, the chip appends a quiet ash mono `· not connected`
  at rest, so the failure reads before a send is attempted rather than
  after; the chip's title states that a tap opens the connect options. The
  model menu lists **connected**
  providers' models first, selectable; models whose provider is not
  connected are listed under a mono rule `connect ▸` and choosing one opens
  the Connect sheet instead of switching. A switch appends the handoff only
  once the next turn runs. The view budget is not a control of its own; it
  lives in the model menu's footer, three steps (`8k demo`, `32k`, `128k`).
  **Dictation** appears only when the browser's `SpeechRecognition` is
  present (`apps/app/src/speech.ts`): the mic button pulses kiln while
  listening, appends heard text onto whatever was already typed, and stops
  itself when the turn is sent.
* **Arrival.** On send, the question drifts out of the composer into the
  ring — 700ms, scaling from 1 to 0.4 while it fades (`.entering`,
  `apps/app/src/styles.css`) — and the newest angular slot lights and
  spreads outward across the ring's eighteen rings over 900ms
  (`arrivalAlpha`, `apps/app/src/ring.ts`); the archive figure increments
  once the light settles. The first delta of the assistant's answer does
  the same for that turn. Reduced motion cuts straight to the final state.
* **Provider sign-in** and **Connect** (local) share one screen: the
  Empyrean plate at low opacity, the wordmark, one line — *One conversation.
  Every model. Nothing forgotten silently.* — and the buttons: **Sign in
  with xAI** (device code in mono, `Open x.ai`, quiet polling that survives
  a transient error), **Use an API key**, **Import Grok CLI login**. Errors
  read in oxblood mono and never end the flow by themselves.
* **The empty thread.** The ring sits alone above one line — *Say anything.
  It will be kept.* — and one quiet mono link, `or open the proof thread →`.
  On a local run with no provider connected, a ghost pill `Connect a model →`
  sits between the line and that link, opening the same Connect sheet as the
  model menu's `connect ▸`; it disappears once any provider reports
  credentials. Opening the proof thread link seeds a deterministic scripted
  provider through the normal
  turn lane, then opens a tour whose intro line names all five acts in
  plain words — *"Five moments from one scripted proof thread: what
  changed, what was found, what was deleted, the exact tail of a stored
  file, and what the archive could still support."* — a correction with its
  current witness, a partial collection, an explicit invalidation, an exact
  attachment tail, and the remembered-claim gate; the internal codename
  this proof once used does not appear in the UI copy. Every displayed value
  comes from `DemoSummary` or a packet/page receipt; the tour says that
  routes and witnesses, not model assurances, are the claim. Source,
  compact-receipt, route, and attachment links open bounded evidence inline.
  A proof thread keeps a read-only **open the proof tour** reentry after
  reload. It is a product demonstration, not a benchmark
  (`packages/core/src/demo.ts`, `apps/app/src/components/ProofTour.tsx`).
* Handoff: `Grok stopped here. Claude continued from the same thread.` as a
  hairline line in the archive drawer; in the presence, the ring flickers
  once.
* Motion 150–220ms ease-out; streaming text has no typewriter gimmick.
* Dark mode follows the system. Under 720px the ring shrinks to 30vmin and
  sits above the exchange; the composer stays pinned.

## The landing page

Kiln ground edge to edge, one scroll, the frame inset. Structure:

1. **Nav** (mono, uppercase, bone): the **mark** — a 44px disc showing the
   Empyrean plate cropped to its bright core inside a hairline-bone ring,
   turning once every 120s at rest, once every 20s while the wordmark is
   hovered, and not at all under reduced motion — beside `PYLOS`; a mono
   pulse in an engraved capsule (`--corner`, hairline-kiln border, tabular
   mono, a breathing kiln→bone dot, static under reduced motion) reading
   `OUR PROOF RUN 1,000,000 turns · chain ✓` — the leading words say whose
   number it is before the figure counts up from 0 over 2.4s on load — a
   title tooltip naming `bench/results/million-6.md`, collapsing to
   `OUR PROOF RUN 1,000,000 ✓` at ≤1000px and dropped entirely below 620px;
   then `THEORY · GITHUB · INSTALL`, hiding `THEORY · GITHUB` at ≤780px and
   `INSTALL` at ≤440px, and a bone pill `ASK THE THREAD` → `#console`. Nav
   links hover as a bone rule sliding in from the left. The bar lives inside
   the frame (see the frame bullet above) and is flat kiln at the top of the
   page; past 24px of scroll `data-scrolled` gives the bar itself — not a
   full-bleed header — a background at 88% kiln colour-mix, a 10px backdrop
   blur, and a bottom hairline.
2. **Hero**: eyebrow `Open source · Apache-2.0 · macOS + Linux`; display
   `The conversation / that does not end`; the lede — *"One thread. Every
   model. A million turns deep, and the exact words come back — with a
   receipt for everything the model's view left out."* — a
   bone pill **Ask the million-turn thread** (→ `#console`), a ghost pill
   **Install**, and the mono line
   `curl -fsSL https://pylos.vercel.app/install.sh | bash` with a copy
   control. Right column: the Empyrean plate, bleeding past the frame.
3. **The story** — the historical v1 model drill, told in plain words with no
   vocabulary, four beats on one screen: turn 1 *"Rule: never send a
   production migration before the dry-run database is verified."*; turn 966
   *"…unless the change is additive-only and the dry-run was skipped by the
   on-call lead."*; a mono counter `966 → 1,000,000 turns later`; the
   question; and two answer blocks side by side — *an ordinary chat
   (rolling summary)* answering from the stale rule, marked `wrong · the
   rule changed on turn 966` in oxblood, and *Pylos* answering from the
   revision, marked `turn 966 · current rule in packet`. Below the cards, a
   mono receipt row names each figure it shows and links the artifact each
   one is checked against, every entry with its own title tooltip:
   `run seed · …`, `hash of the last turn · …`, and
   `hash of what the model read · …` — the run's seed, the head of the
   archive's hash chain, and the hash of the exact packet handed to the
   model for this question, so the answer above can be checked against what
   was actually asked. The recorded
   answers and probe counts on the answer cards, and the hashes, come from
   [`bench/results/million-live-live-1.md`](../bench/results/million-live-live-1.md);
   the caption is the single pointer *"A live sample at turn 2,000 — the
   deterministic proof is below."* plus the artifact link — it no longer
   restates the benchmark disclaimer inline, which now lives in the "what is
   proven, what is not" section.
4. **The features** — a bone panel inset from the frame, three columns,
   each an eyebrow, a display head, a kiln-on-bone plate, a mono caption:
   `#1 Remember` *Ask, don't scroll* — *"Every turn is kept exactly and
   hashed into a chain. Ask for turn 61,234, or for what Esme Whitlock
   said — a name planted deep in the million-turn thread you can question
   further down this page — and the bytes come back, not a paraphrase."*,
   the pointer resolving at the console; `#2 Bounded` *The
   view never grows* — *"The model reads a fixed budget whether the thread
   is ten turns or a million. Whatever the budget cannot hold is written to
   a ledger with an address, never dropped in silence."*; `#3 Every model`
   *One thread* — *"Grok stops, Claude continues, a local model finishes.
   The thread is the agent; the model is the visitor."*
5. **The proof** — eyebrow `The proof · deterministic · zero model calls ·
   kernel 2.0.0`; display `1,000,000 turns. / The view never grew.` and the
   chart: x is turns 0 → 1,000,000 at the bench's 100 checkpoints; a bone
   area climbing to **1458 MiB** of archive; a flat bone line at the view
   (~7.9k tokens) under a dashed hairline at the cap 8,192 — the flat-line
   concession ("a rolling summary is flat too, so the claim is the panel
   below") is one clause inside the chart caption, not a section of its own.
   Beneath it the panel that is the claim — *what recognized routes can still
   bring back, exactly, within this fixture* — Pylos flat at 100% across every
   planted family, the rolling summary falling to 29%, BM25 to 10%. Drawn as
   SVG from `public/bench/series.json` (derived deterministically from
   `bench/results/million-6.json` at build). Under it, a mono receipt row:
   `final checkpoint: 2,000/2,000 facts · 200/200 quotes exact · 50/50 numbers ·
   2,000/2,000 name-free memories · across checkpoints: 10,000/10,000 turn
   numbers · 2,000/2,000 faults receipted · chain ✓ to #1,000,000` — every
   figure a link to the artifact. These are finite-fixture receipts, not
   universal recall or semantic-width evidence. The Flammarion plate sits
   behind at low opacity.
6. **What is proven, what is not** — after the proof, three mono-eyebrow
   columns headed `PROVEN`, `EXPERIMENTAL`, `NOT CLAIMED`: proven states
   exact recall by address across the 1,000,000-turn checkpoint, chain
   verified; experimental states the natural-question receipt's 6-of-13
   intended sources and 5-of-13 wrong ones, and that a suggestion is
   verified against the stored bytes before it is used; not claimed states
   plainly that no phrasing is guaranteed to find its source, that the
   model's answers are not guaranteed correct, and that no number outside
   `bench/results` is claimed. A mono link `Read the receipts →` points at
   `bench/results` on GitHub. Every figure here traces to
   [`bench/results/natural.md`](../bench/results/natural.md) and
   [`bench/results/natural.json`](../bench/results/natural.json).
7. **The aperture** — the live in-browser run of the browser-safe compiler (counter
   racing to 1,000,000, view flat, the ledger strip, the recovered span) —
   restyled, unchanged in mechanics and hooks. The six-term gloss strip is
   gone; one quiet line instead states the convention (*"Plain words first.
   The word after each dot is what Pylos calls it — hover a marked term for
   the whole definition."*), and each of the panel's seven marked terms
   (archive, packet, frontier, capsules, paged, ledger, and — in the
   console's lede, not the panel — certificate) is glossed plain-words-first
   at its first use (`archive` → "Every turn, kept exactly", `packet` →
   "What the model reads", `frontier` → "the facts currently standing",
   `capsules` → "summaries of older turns", `paged` → "fetched back for this
   question", `ledger` → "What the summaries dropped, with a way back to
   it"), the full definition carried as a `title` tooltip on the term
   itself (a `dfn`, see Shape & space). Compaction levels, fan-out, and the
   seed are named in plain words in the timeline caption and the closing
   note rather than as jargon. The panel opens on a waking state — the
   archive figure reads `—`, its caption *"Waking the million-turn
   archive…"*, the ledger count *"waiting for the first summary to
   seal"* — rather than zeros, so a page load reads as a run starting, not
   a run that failed. A closing note of two sentences names what is
   running (the browser-safe compiler, no vault, no chain, no index, over a
   million turns from the bench's own generator) and that keeping no vault
   makes its counters smaller than the bench's own artifact in
   `bench/results`.
8. **Ask the thread** (`#console`) — the console: one input, mono chips, the
   answer cards; each chip's label is exactly the text it submits. A
   person can be asked for by any part of the name, lower case included;
   an ambiguous part answers with the candidates, not a miss. A question
   about the world (no cue that refers back) is
   answered with a card headed `⟦no turn about that · not a memory⟧` — the
   thread has no turn about that; a model would answer it from what it knows —
   and is not a fault. A question that refers back and reaches no route is
   headed `⟦looked back, found no route to a turn · page fault⟧`, and that one
   is receipted as a failure. A recovered address is headed, e.g.,
   `⟦brought back turn #1,000,001 · by its own words⟧` — the plain-speech clause
   changes with the route that fired, and the route's own name stays in the mono
   receipt line beneath the header, not the header itself. The
   visitor can also *authorize an assertion* in the thread — a line starting
   `remember:` appends turn 1,000,001 to the in-browser archive — and
   then ask for it back; the recovery card follows the same headline
   convention, naming the turn brought back, and the visitor has put their own
   fact into a million-turn thread.
9. **Install** — eyebrow `Install · v2.0.0 · Apache-2.0`. Two release-asset
   cards, macOS (Apple silicon, `pylos-2.0.0.dmg`) and Linux (x64 `.deb`,
   `pylos-2.0.0.deb`), each naming its platform and file and a bone pill
   **Download →** pointed at the tagged GitHub release asset. Below that,
   `Install via terminal`, the same
   `curl -fsSL https://pylos.vercel.app/install.sh | bash` line with a copy
   control, and three numbered steps: `01` the curl line installs `pylos`
   to `~/.local/bin`; `02` `pylos serve` runs the API on
   `127.0.0.1:7334`, loopback only; `03` open
   `http://127.0.0.1:7334/app/` — the same one composer, against a vault in
   your own home directory. A closing note states that the desktop app and
   `pylos serve` share one vault format, that `.pylos` exports verify their
   hash chain on import, that `pylos serve --hosted` binds beyond loopback
   for a machine you own and asks for a token, that Pylos is not a public
   hosted service, and that builds are unsigned for now (right-click → Open
   on macOS the first time).
10. **Footer** — *THE TABLETS SURVIVED BECAUSE THE PALACE BURNED.* in display,
   the credits row, and the meta row — `Pylos v2.0.0`, `Apache-2.0`, the
   year, `GitHub`, `Theory` — and the ghost wordmark `pylos` in kiln-deep
   across the bottom.

OG image: kiln ground on the left, the mark (the Empyrean plate's core in a
disc) beside the wordmark, the headline and the turn/view/ledger figures in
mono, the Empyrean plate filling the right column. Built as HTML with the
same self-hosted fonts and photographed headless
(`apps/web/scripts/assets.ts`), so its numbers come from the same run
snapshot the aperture ships (`public/aperture/final.json`).
