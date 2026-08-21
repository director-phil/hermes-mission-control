import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const port = Number(process.env.MC_VISUAL_PORT ?? 3211);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
let server: ChildProcessWithoutNullStreams | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  if (process.env.PLAYWRIGHT_BASE_URL) return;

  server = spawn(
    "corepack",
    ["pnpm", "exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        MC_ALLOWED_REPO: repoRoot,
      },
    },
  );

  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForServer();
});

test.afterAll(async () => {
  if (!server) return;
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test(`Mission Control reference shell visual gate: ${viewport.name}`, async ({ page }) => {
    const evidence = await openShell(page, viewport);

    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeAttached();
    await expect(page.getByRole("navigation", { name: "Mission Control" })).toHaveCount(1);
    await expect(page.locator('[aria-current="page"]')).toHaveText("Overview");
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.getByText("not delivered yet")).toBeVisible();
    await expect(page.getByText(/target:/)).toBeVisible();
    await expect(page.getByText(/source:/)).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    if (viewport.width > 1024) {
      const rail = page.locator(".mc-desktop-rail");
      await expect(rail).toBeVisible();
      const box = await rail.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(240);
      expect(box?.width).toBeLessThanOrEqual(280);
      await expect(page.getByRole("button", { name: "Open Mission Control navigation" })).toBeHidden();
    } else {
      const menu = page.getByRole("button", { name: "Open Mission Control navigation" });
      await expect(menu).toBeVisible();
      const menuBox = await menu.boundingBox();
      expect(menuBox?.width).toBeGreaterThanOrEqual(44);
      expect(menuBox?.height).toBeGreaterThanOrEqual(44);
      await menu.click();
      await expect(page.getByRole("dialog", { name: "Mission Control navigation" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Overview" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: "Mission Control navigation" })).toBeHidden();
      await expect(menu).toBeFocused();
    }

    await page.screenshot({
      path: `tests/visual/artifacts/mission-control-${viewport.name}.png`,
      fullPage: true,
    });

    expect(evidence.failedRequests).toEqual([]);
    expect(evidence.consoleErrors).toEqual([]);
  });
}

test("Mission Control placeholder routes are explicit and read-only", async ({ page }) => {
  await openShell(page, { name: "route", width: 1440, height: 900 });
  await page.getByRole("link", { name: "Documentation" }).click();
  await expect(page).toHaveURL(`${baseURL}/mission-control/documentation`);
  await expect(page.getByRole("heading", { name: "Documentation" })).toBeVisible();
  await expect(page.getByText("not delivered yet")).toBeVisible();
  await expect(page.locator("button").filter({ hasText: /sync|run|deploy|approve/i })).toHaveCount(0);
});

async function openShell(
  page: Page,
  viewport: { name: string; width: number; height: number },
) {
  const failedRequests: string[] = [];
  const consoleErrors: string[] = [];
  const environmentResponses: number[] = [];

  page.on("requestfailed", (request) => failedRequests.push(request.url()));
  page.on("response", (response) => {
    if (response.url().includes("/api/mission-control/environment")) {
      environmentResponses.push(response.status());
    }
    if (response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`${baseURL}/mission-control`, { waitUntil: "networkidle" });
  await expect.poll(() => environmentResponses.length).toBeGreaterThan(0);
  expect(environmentResponses.every((status) => status === 200)).toBe(true);

  return { failedRequests, consoleErrors };
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/mission-control`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Timed out waiting for ${baseURL}`);
}
