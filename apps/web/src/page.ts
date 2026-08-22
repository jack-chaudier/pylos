/**
 * Page behaviour that is not the aperture: copying the install line, marking
 * the visitor's platform, and moving focus with in-page links so the keyboard
 * lands where the page just travelled.
 */

/**
 * The hosted app. `vercel.json` rewrites /app/* (and /api/*, /v1/*) to the
 * backend, so the landing page and the app share an origin. One place.
 */
export const APP_URL = "/app/";

const LIVE_ID = "pylos-live";

function live(): HTMLElement {
  let node = document.getElementById(LIVE_ID);
  if (!node) {
    node = document.createElement("p");
    node.id = LIVE_ID;
    node.className = "sr";
    node.setAttribute("role", "status");
    document.body.append(node);
  }
  return node;
}

function announce(message: string): void {
  live().textContent = message;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ── copy ────────────────────────────────────────────────────────────────────

/** The rendered command carries a decorative `$`; never copy it. */
function commandText(source: Element): string {
  const clone = source.cloneNode(true) as Element;
  clone.querySelector("[aria-hidden='true']")?.remove();
  return (clone.textContent ?? "").trim();
}

function legacyCopy(text: string): boolean {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.top = "-1000px";
  document.body.append(field);
  field.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  field.remove();
  return ok;
}

function flash(button: HTMLElement, label: string): void {
  const slot = button.querySelector<HTMLElement>(".copy__label") ?? button;
  const original = button.dataset.original ?? slot.textContent ?? "Copy";
  button.dataset.original = original;
  slot.textContent = label;
  const prior = Number(button.dataset.timer ?? 0);
  if (prior) window.clearTimeout(prior);
  button.dataset.timer = String(
    window.setTimeout(() => {
      slot.textContent = original;
    }, 1800),
  );
}

function wireCopy(): void {
  for (const button of document.querySelectorAll<HTMLElement>("[data-copy]")) {
    const sel = button.dataset.copy;
    const source = sel ? document.querySelector(sel) : null;
    if (!source) continue;

    button.addEventListener("click", () => {
      const text = commandText(source);
      const ok = () => {
        flash(button, button.dataset.copiedLabel ?? "Copied");
        announce("Install command copied. Paste it in a terminal.");
      };
      const fail = () => {
        flash(button, "Select it");
        announce("Copying was blocked. Select the command manually.");
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(ok, () => {
          if (legacyCopy(text)) ok();
          else fail();
        });
      } else if (legacyCopy(text)) {
        ok();
      } else {
        fail();
      }
    });
  }
}

// ── platform ────────────────────────────────────────────────────────────────

function detectOS(): "mac" | "linux" | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const probe =
    `${nav.userAgentData?.platform ?? ""} ${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  if (/android|iphone|ipad|ipod/.test(probe)) return null;
  if (/mac|darwin/.test(probe)) return "mac";
  if (/linux|x11|cros|bsd/.test(probe)) return "linux";
  return null;
}

function markPlatform(): void {
  const os = detectOS();
  if (!os) return;
  const card = document.querySelector<HTMLElement>(`.card[data-os="${os}"]`);
  if (card) {
    card.dataset.current = "true";
    const meta = document.createElement("p");
    meta.className = "card__meta card__meta--here";
    meta.textContent = "· your platform";
    card.querySelector(".card__os")?.after(meta);
  }
}

// ── anchors ─────────────────────────────────────────────────────────────────

function wireAnchors(): void {
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>('a[href^="#"]');
    if (!link) return;
    const id = link.getAttribute("href")?.slice(1);
    if (!id) return;
    const dest = document.getElementById(id);
    if (!dest) return;

    event.preventDefault();
    dest.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    if (!dest.hasAttribute("tabindex")) dest.setAttribute("tabindex", "-1");
    dest.focus({ preventScroll: true });
    history.replaceState(null, "", `#${id}`);
  });
}

function wireAppLinks(): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-app-url]")) {
    link.href = APP_URL;
  }
}

export function mountPage(): void {
  wireCopy();
  markPlatform();
  wireAnchors();
  wireAppLinks();
}
