// content.js
// Runs on claude.ai pages. Provides a BEST-EFFORT way to push a generated
// skeleton file into a Project's Knowledge panel by finding a native file
// input and populating it programmatically.
//
// HONEST LIMITATION: claude.ai's DOM is not a stable public API. This was
// written without live access to the current page structure, so selectors
// are pattern/text-based guesses, not verified against production markup.
// It will report failure clearly rather than pretending to succeed — the
// popup always offers "Download file" / "Copy to clipboard" as a manual
// fallback that does not depend on any of this working.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "TOKEN_OPTIMIZER_AUTO_UPLOAD") return false;

  attemptUpload(msg.filename, msg.content)
    .then(sendResponse)
    .catch((e) => sendResponse({ success: false, reason: `Unexpected error: ${e.message}` }));

  return true; // keep the async sendResponse channel open
});

async function attemptUpload(filename, content) {
  if (!/\/project\//.test(location.pathname)) {
    return {
      success: false,
      reason: "This doesn't look like a Project page (no '/project/' in the URL). Open the target Project first.",
    };
  }

  let input = document.querySelector('input[type="file"]');

  if (!input) {
    const trigger = findAddContentTrigger();
    if (!trigger) {
      return {
        success: false,
        reason:
          "Couldn't find an 'Add content' button on this page. claude.ai's UI may not match what this was built against — use Download or Copy instead.",
      };
    }
    trigger.click();
    await wait(700);
    input = document.querySelector('input[type="file"]');
  }

  if (!input) {
    return {
      success: false,
      reason: "Found a possible upload trigger but no file input appeared after clicking it. Use Download or Copy instead.",
    };
  }

  try {
    const file = new File([content], filename, { type: "text/markdown" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {
    return { success: false, reason: `File input assignment failed: ${e.message}` };
  }

  return {
    success: true,
    reason: `Dispatched "${filename}" to a file input on this page. Confirm it landed in Project Knowledge — this tool can't verify the upload actually completed server-side.`,
  };
}

function findAddContentTrigger() {
  const textMatch = /add content|add to project|upload|add knowledge/i;
  const buttons = Array.from(document.querySelectorAll("button"));
  return buttons.find((b) => textMatch.test(b.textContent || "")) || null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
