// popup.js — entry point. Wires up tab switching and initializes all three views.
import { initPulseView } from "./pulseView.js";
import { initProjectsView } from "./projectsView.js";
import { initSettingsView } from "./settingsView.js";

function initTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      panels.forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

initTabs();
initPulseView();
initProjectsView();
initSettingsView();