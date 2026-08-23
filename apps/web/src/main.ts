/** pylos.vercel.app — entry point. */

import "./styles.css";
import { mountAperture } from "./aperture/view";
import { mountPage } from "./page";
import { mountProof } from "./proof";
import { mountTrap } from "./trap";

function boot(): void {
  mountPage();
  try {
    mountAperture();
  } catch (err) {
    // the page is still a page without the demo
    console.error("[pylos] aperture failed to mount", err);
  }
  void mountTrap();
  void mountProof();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
