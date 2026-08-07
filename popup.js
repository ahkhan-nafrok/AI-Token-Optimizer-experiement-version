// popup.js — entry point. Wires up tab switching (including the Settings
// gear toggle) and initializes all three views.
//
// UI/UX pass (this session): Settings is no longer a third tab button — the
// nav now shows just Pulse/Projects plus a gear icon. Clicking the gear
// does a full swap: the Pulse/Projects tab buttons hide, a "Settings" label
// takes their place, the settings panel becomes active, and the gear icon
// itself turns into a back arrow. Clicking it again restores whichever of
// Pulse/Projects was active before Settings was opened.
import { initPulseView } from "./pulseView.js";
import { initProjectsView } from "./projectsView.js";
import { initSettingsView } from "./settingsView.js";

function initTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".tab-panel");
  const tabsMain = document.getElementById("tabs-main");
  const settingsNavLabel = document.getElementById("settings-nav-label");
  const settingsToggleBtn = document.getElementById("settings-toggle-btn");

  let lastMainTab = "pulse";

  function activatePanel(tabName) {
    panels.forEach((p) => p.classList.remove("active"));
    const panel = document.getElementById(`tab-${tabName}`);
    if (panel) panel.classList.add("active");
  }

  function setActiveTabBtn(tabName) {
    tabBtns.forEach((b) => {
      const isActive = b.dataset.tab === tabName;
      b.classList.toggle("active", isActive);
      b.setAttribute("aria-selected", String(isActive));
    });
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabName = btn.dataset.tab;
      lastMainTab = tabName;
      setActiveTabBtn(tabName);
      activatePanel(tabName);
    });
  });

  settingsToggleBtn.addEventListener("click", () => {
    const inSettings = settingsToggleBtn.classList.contains("is-back");

    if (inSettings) {
      // Back arrow clicked — return to whichever main tab was active
      // before Settings was opened.
      settingsToggleBtn.classList.remove("is-back");
      settingsToggleBtn.setAttribute("aria-label", "Settings");
      settingsToggleBtn.title = "Settings";
      tabsMain.hidden = false;
      settingsNavLabel.hidden = true;
      setActiveTabBtn(lastMainTab);
      activatePanel(lastMainTab);
    } else {
      // Gear clicked — remember the current tab, then swap the whole tab
      // area over to Settings.
      const currentActive = document.querySelector(".tab-btn.active");
      lastMainTab = currentActive ? currentActive.dataset.tab : "pulse";
      settingsToggleBtn.classList.add("is-back");
      settingsToggleBtn.setAttribute("aria-label", "Back");
      settingsToggleBtn.title = "Back";
      tabsMain.hidden = true;
      settingsNavLabel.hidden = false;
      activatePanel("settings");
    }
  });
}

initTabs();
initPulseView();
initProjectsView();
initSettingsView();