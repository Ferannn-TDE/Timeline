import {defineConfig} from "@playwright/test";
// Load real deployed application/worker assets, with an entirely isolated backend.
// No real journal entries, sessions or document writes are permitted by this test.
if(process.env.HEIF_PRODUCTION_ASSETS_ONLY!=="1")throw Error("This config requires explicit isolated production-assets mode.");
export default defineConfig({testDir:"tests/browser",grep:/real HEIC|upload and preview remain supported/,workers:2,reporter:"list",outputDir:"artifacts/heif-production",use:{baseURL:"https://moments-timeline-rho.vercel.app",launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}}});
