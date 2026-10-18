let installPrompt = null,
  registration = null,
  notify = () => {},
  hasDraft = () => false;
let installedHere = false;
let reloadRequested = false,
  lastCheck = 0;
const installed = () =>
  installedHere ||
  matchMedia("(display-mode: standalone)").matches ||
  navigator.standalone === true;
export function installCard() {
  return `<section class="panel" data-install-card><h2>Install Asterism</h2><p>Keep your reader on your home screen or desktop. Connect to the internet to load posts and send actions.</p><p data-install-status>${installed() ? "Running as an installed app." : ""}</p><button class="button primary" data-do="install-app" ${installed() ? "disabled" : ""}>${installed() ? "Installed" : installPrompt ? "Install Asterism" : "Installation instructions"}</button><details class="install-help"><summary>How to install on your device</summary><ul><li><strong>Android:</strong> open this site in Chrome, then use Install app or Add to Home screen in its menu.</li><li><strong>iPhone or iPad:</strong> open in Safari, then Share → Add to Home Screen. Enable Open as Web App if shown.</li><li><strong>Desktop:</strong> use Chrome or Edge’s install option. In Safari on Mac, use File → Add to Dock.</li></ul></details></section>`;
}
function refreshCard() {
  const card = document.querySelector("[data-install-card]");
  if (!card) return;
  const button = card.querySelector("[data-do=install-app]");
  button.disabled = installed();
  button.textContent = installed()
    ? "Installed"
    : installPrompt
      ? "Install Asterism"
      : "Installation instructions";
  card.querySelector("[data-install-status]").textContent = installed()
    ? "Running as an installed app."
    : "";
}
export async function installApp() {
  if (!installPrompt) {
    const help = document.querySelector(".install-help");
    if (help) help.open = true;
    return;
  }
  const prompt = installPrompt;
  installPrompt = null;
  const result = await prompt.prompt();
  refreshCard();
  if (result.outcome === "accepted")
    notify(
      "Installation requested. Your browser will finish setting up Asterism.",
    );
}
export async function updateApp() {
  if (hasDraft()) {
    notify(
      "Finish or clear your reply drafts and close other dialogs before updating.",
    );
    return;
  }
  reloadRequested = true;
  if (registration?.waiting)
    registration.waiting.postMessage({ type: "ACTIVATE_UPDATE" });
  else location.reload();
}
export function startPwa(options) {
  notify = options.notify;
  hasDraft = options.hasDraft;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    refreshCard();
  });
  window.addEventListener("appinstalled", () => {
    installedHere = true;
    installPrompt = null;
    refreshCard();
    notify("Asterism installed.");
  });
  const network = () => {
    document.querySelector("#offline-notice").hidden = navigator.onLine;
  };
  window.addEventListener("online", network);
  window.addEventListener("offline", network);
  network();
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadRequested && !hasDraft()) location.reload();
  });
  navigator.serviceWorker
    .register("/sw.js", { scope: "/", updateViaCache: "none" })
    .then((value) => {
      registration = value;
      const waiting = () => {
        if (registration.waiting)
          document.querySelector("#update-notice").hidden = false;
      };
      waiting();
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (
            worker.state === "installed" &&
            navigator.serviceWorker.controller
          )
            waiting();
        });
      });
      const check = () => {
        if (
          document.hidden ||
          !navigator.onLine ||
          Date.now() - lastCheck < 3600_000
        )
          return;
        lastCheck = Date.now();
        void registration.update().catch(() => {});
      };
      window.addEventListener("online", check);
      document.addEventListener("visibilitychange", check);
    })
    .catch(() => {
      // Installation can still work without offline support; keep the reader usable.
    });
}
