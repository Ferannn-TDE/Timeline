// Picker alone receives a short-lived per-file access token in browser memory.
// Refresh tokens and client secrets never enter this module or browser storage.
type PickerConfig = { access_token: string; picker_key: string; project_number: string; document_id: string };
declare global { interface Window { gapi?: any; google?: any } }
let loading: Promise<void> | null = null;
function loadPicker(): Promise<void> {
  if (window.google?.picker) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script"); script.src = "https://apis.google.com/js/api.js"; script.async = true;
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
    const fail = (message: string) => { if (settled) return; settled = true; clearTimeout(timer); loading = null; script.remove(); reject(Error(message)); };
    const timer = setTimeout(() => fail("Google Picker's script did not load within 15 seconds. Retry and check whether apis.google.com is blocked for this website."), 15000);
    script.onerror = () => fail("Google Picker could not load. Retry when Google is available.");
    script.onload = () => {
      if (!window.gapi) { fail("Google Picker did not initialize. Retry loading it."); return; }
      window.gapi.load("picker", { callback: finish, onerror: () => fail("Google Picker failed to load."), timeout: 10000, ontimeout: () => fail("Google Picker timed out.") });
    };
    document.head.appendChild(script);
  });
  return loading;
}
export async function openGooglePicker(config: PickerConfig, selected: (id: string) => Promise<void>, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let picker: any, settled = false, checking = false;
    const controls = document.createElement("div"); controls.className = "google-picker-controls";
    controls.setAttribute("role", "region"); controls.setAttribute("aria-label", "Google Docs file selection controls");
    const notice = document.createElement("span"); notice.textContent = "Loading Google Docs file selection…"; notice.setAttribute("role", "status");
    const close = document.createElement("button"); close.type = "button"; close.textContent = "Close Google Doc selection";
    controls.append(notice, close); document.body.append(controls);
    const finish = (error?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(timer); controls.remove(); signal?.removeEventListener("abort", cancel);
      window.removeEventListener("keydown", escape, true);
      try { picker?.dispose(); } catch { /* Close/retry remains usable if Google's cleanup fails. */ }
      if (error) reject(error); else resolve();
    };
    const cancel = () => finish();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
    const timer = setTimeout(() => finish(Error("Google Doc selection did not finish within two minutes. Retry selection. If Google asks you to sign in, open drive.google.com as the same approved account first. If it reports an invalid developer key, allow this website and https://docs.google.com/* in the restricted Picker key. Journal changes remain queued.")), 120000);
    close.onclick = cancel; signal?.addEventListener("abort", cancel, { once: true }); window.addEventListener("keydown", escape, true);
    if (signal?.aborted) { cancel(); return; }
    void loadPicker().then(() => {
      if (settled) return;
      const google = window.google;
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes("application/vnd.google-apps.document");
      picker = new google.picker.PickerBuilder().addView(view).setAppId(config.project_number).setDeveloperKey(config.picker_key).setOAuthToken(config.access_token).setOrigin(window.location.origin).setTitle("Select the Moments Timeline shared Google Doc").setCallback((data: any) => {
      if (settled || checking) return;
      if (data.action === google.picker.Action.ERROR) {
        finish(Error("Google Picker could not authorize file selection. Check that Google Picker API is enabled and its key allows this website and https://docs.google.com/* in the same Google Cloud project. Your journal changes remain queued; retry selection after correcting the setting."));
        return;
      }
      if (data.action === google.picker.Action.CANCEL) { cancel(); }
      if (data.action === google.picker.Action.PICKED) {
        const id = data.docs?.[0]?.id;
        if (id !== config.document_id) { finish(Error("Select the supplied Moments Timeline Google Doc. No document content was changed.")); return; }
        checking = true; notice.textContent = "Checking shared document access…";
        picker.setVisible(false);
        void selected(id).then(() => finish(), error => finish(error instanceof Error ? error : Error("Document access could not be confirmed. Retry selection.")));
      }
    }).build();
      notice.textContent = "Choose the shared Google Doc. If Google requests sign-in, use the same approved account.";
      picker.setVisible(true);
    }).catch(error => finish(error instanceof Error ? error : Error("Google Picker could not load. Retry selection.")));
  });
}
