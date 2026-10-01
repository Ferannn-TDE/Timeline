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
    const fail = (message: string) => { loading = null; script.remove(); reject(Error(message)); };
    script.onerror = () => fail("Google Picker could not load. Retry when Google is available.");
    script.onload = () => {
      if (!window.gapi) { fail("Google Picker did not initialize. Retry loading it."); return; }
      window.gapi.load("picker", { callback: resolve, onerror: () => fail("Google Picker failed to load."), timeout: 10000, ontimeout: () => fail("Google Picker timed out.") });
    };
    document.head.appendChild(script);
  });
  return loading;
}
export async function openGooglePicker(config: PickerConfig, selected: (id: string) => Promise<void>) {
  await loadPicker();
  return new Promise<void>((resolve, reject) => {
    const google = window.google;
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes("application/vnd.google-apps.document");
    const picker = new google.picker.PickerBuilder().addView(view).setAppId(config.project_number).setDeveloperKey(config.picker_key).setOAuthToken(config.access_token).setOrigin(window.location.origin).setTitle("Select the Moments Timeline shared Google Doc").setCallback((data: any) => {
      if (data.action === google.picker.Action.ERROR) {
        picker.dispose();
        reject(Error("Google Picker could not authorize file selection. Retry selection; if it fails again, check that Google Picker API is enabled and its key allows this website in the same Google Cloud project. Your journal changes remain queued."));
        return;
      }
      if (data.action === google.picker.Action.CANCEL) { picker.dispose(); resolve(); }
      if (data.action === google.picker.Action.PICKED) {
        const id = data.docs?.[0]?.id; picker.dispose();
        if (id !== config.document_id) { reject(Error("Select the supplied Moments Timeline Google Doc. No document content was changed.")); return; }
        void selected(id).then(resolve, reject);
      }
    }).build();
    picker.setVisible(true);
  });
}
