/** pylos.dev — entry point. */

import "./styles.css";
import { mountAperture } from "./aperture/view";
import { mountPage } from "./page";
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
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
