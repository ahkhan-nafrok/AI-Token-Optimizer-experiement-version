// popup.js — entry point. Wires up tab switching and initializes both views.
import { initSkeletonizerView } from "./skeletonizerView.js";
import { initProjectsView } from "./projectsView.js";

function initTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

initTabs();
initSkeletonizerView();
initProjectsView();
