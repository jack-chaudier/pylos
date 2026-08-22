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
| `--verdigris` | `#1F6F5C` | `#4FB39A` | accent: links, primary buttons, focus, the evidence bar |
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
* Top edge: the thread title in Newsreader, and at the far right the
  **evidence bar** — a mono strip `archive N turns · N GiB · view X / B ·
  ledger N · recovered N · N models · chain ✓`, each figure with a hover title
  explaining what it counts. When a turn ran more than one provider request
  the view figure grows a suffix — `view 7.9k / 8.2k · 3 rounds` — since the
  budget the kernel guarded was spent across rounds, not once. It is the only
  place the machinery shows; clicking it opens the **X-ray** drawer. A changed
  figure settles rather than jumps (220ms). A resident meter beneath it fills
  with ember as the packet is built, then settles. Under 720px the bar
  collapses to archive, view and recovered — the three that change while you
  talk.
* Hosted mode opens on a **sign-in screen**: wordmark, one line (*One
  conversation. Every model. Nothing forgotten silently.*), a pill **Sign in
  with xAI**. Starting it shows a one-time user code in Geist Mono and a pill
  **Open x.ai**; the screen polls quietly until the browser confirms. Once
  signed in, a small **account** control (initial in a circle) sits beside the
  evidence bar — who is signed in, and sign out.
* A checked answer: when a draft names something the view did not contain and
  the ledger knows where it is, Pylos pages the exact text and gives the model
  one round to reissue the answer. The provisional text is dropped and
  `↺ reopened the archive · names` appears above the answer that replaced it,
  in ember mono. If the check round itself could not complete, the line reads
  `archive could not be re-read · names — unverified`, in oxblood — the draft
  is kept, but the failure is not hidden. If the check ran and nothing
  changed, the line adds `· answer stood`.
* In the X-ray, atoms a model proposed but nothing has confirmed render ash,
  not ink: `≈ key value ⟨proposed by assistant #seq · unconfirmed⟩`. A
  proposal is never a certificate; the ash tone is the tell. The drawer heads
  itself "What the model saw" and, when a turn ran more than one provider
  request, appends the count — "— N rounds" — and every resident span in the
  list carries its `epistemic` tag, with the legend "only supported spans
  count as evidence" underneath.
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
  gimmick.
* Responsive: the timeline rail hides under 720px; the X-ray drawer goes
  full-width; the composer stays pinned to the bottom at every width.
* Dark mode follows the system.

## The landing page

Structure (low density, large type, one scroll):

1. Thin nav: wordmark `pylos`, **Theory** · **GitHub** · **Download** ·
   accent **Try it**, the last linking to `#console`.
2. Hero on bone: overline `OPEN SOURCE · APACHE-2.0 · WEB · MAC + LINUX`, display
   headline **Talk forever.** (alt: *A conversation that outlives every model.*),
   one sentence, three CTAs — pill **Try the impossible thread →** (primary, to
   `#console`), ghost **Install**, and quiet **Watch turn 1,000,000** for the
   aperture.
3. **The aperture** — a live, in-browser run of the real `@pylos/core` compiler
   over a synthetic stream: one counter races toward 1,000,000 turns, the other
   (view tokens) stays flat; a thin ledger strip shows losses being recorded
   and a recovered span lighting up in ember. Ten seconds, no video. When the
   closing question's ledger route does not fire, the exhibit says so —
   `no route fired`, nothing claimed — rather than showing a recovery that
   did not happen. Its closing act shows both receipts the kernel actually
   produces for that run, side by side: `● resident` for the certificate that
   needed no page, `↺ recovered` for the ledger route that did.
4. **The console** (`#console`) — the part of the exhibit a visitor drives: one
   input, mono suggestion pills seeded from the thread's own planted content,
   answering against the same in-browser compiler and the bench's own
   `createCorpus("1", 1_000_000)`, no model call. Answers render as cards,
   newest first, capped at four: the question in Newsreader; the packet's own
   label (`⟦recovered #345 · sequence⟧`, `● resident #483112 · frontier
   certificate`) in ember mono; evidence lines in mono, colored by what they
   are — a certificate ink, a proposal or a historical or an absent line ash,
   the resolved span picked out ember italic within its line; a hairline
   archive-position rail under the card with an ember tick at the answer's
   seq; a mono receipt row (trigger, locator, tokens paged); a caption in ash
   explaining the route. The trap card is the one exception: two columns
   under one headline, the recorded live-bench answers side by side, the
   Pylos column washed verdigris — a visitor can put the same closing
   question to the archive as the bench did, and see both routes and both
   recorded answers at once.
5. Three short statements with mono captions: *The archive is exact.* · *The
   view is bounded.* · *Nothing is forgotten silently.*
6. The trap (from the bench): two columns, same model, same question at turn
   1,000,000 — rolling summary vs Pylos; the baseline follows the stale rule,
   Pylos pages the revision. Real outputs, hash-linked to the bench artifact.
7. Download section: install, run `pylos serve`, open
   `http://127.0.0.1:7334/app/` — cards for macOS and Linux plus a copyable
   install line. `pylos serve --hosted` is documented as supported, for
   self-hosting; Pylos does not run a hosted deployment.
8. Footer: the Pylos line — *The tablets survived because the palace burned.*

OG image: bone background, verdigris wordmark, ember numeral.
