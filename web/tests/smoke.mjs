// Loads a page of the web build in headless Chromium and prints its console.
// usage: node web/tests/smoke.mjs [url] [waitForText] [timeoutMs]
import { chromium } from "@playwright/test";

const [url = "http://localhost:4173/", waitFor = "DONE", timeout = "60000"] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (msg) => console.log(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => console.log(`[pageerror] ${err.stack ?? err}`));
page.on("worker", (w) => console.log(`[worker] ${w.url()}`));
await page.goto(url);
try {
    await page.waitForFunction(
        (t) => document.body.innerText.includes(t) || document.body.innerText.includes("ERROR"),
        waitFor,
        { timeout: Number(timeout) },
    );
} catch (e) {
    console.log("timed out waiting for", waitFor);
}
console.log("---- page text ----");
console.log(await page.evaluate(() => document.body.innerText));
await browser.close();
