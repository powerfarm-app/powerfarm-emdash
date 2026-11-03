#!/usr/bin/env node
// Check Powerfarm's brand in a real browser, on the pinned EmDash, and take screenshots.
//
//   node powerfarm/scripts/visual-check.mjs [--out DIR]
//
// Run from the EmDash workspace that scripts/setup.sh prepared (CI does this
// after the build). It uses EmDash's own Playwright and axe-core, so it adds no
// dependency. Two servers, each with a throwaway database:
//
//   1. A production build (astro.config.node.mjs): the admin's first screen and
//      Powerfarm's two pages. This is the check that the theme stylesheet
//      reaches the admin in a real build, not only in development.
//   2. The development server, signed in through EmDash's dev-only setup bypass
//      (refused outside development): the dashboard, a Powerfarm page and a
//      content list.
//
// Fails when the Powerfarm colours, logo or font are missing from a page, or
// when axe finds a colour-contrast problem on Powerfarm's own pages. Contrast
// findings inside EmDash's admin are reported, not failed: that UI is EmDash's.
// Screenshots and a report go to --out (default .visual) for the CI run's artifacts.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const OUT = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : ".visual");
const SITE = path.resolve("powerfarm/site");
const ASTRO = path.resolve(SITE, "node_modules/.bin/astro");
mkdirSync(OUT, { recursive: true });

// What theme.css and tokens.css set. Kept here, not imported, so a change to
// either file has to be made on purpose in both.
const EXPECT = {
	light: { brand: "#080702", body: "rgb(248, 223, 193)" },
	dark: { brand: "#a83a08", body: "rgb(8, 7, 2)" },
};

const failures = [];
const report = [];
const fail = (msg) => {
	failures.push(msg);
	console.error(`FAIL ${msg}`);
};
const ok = (msg) => console.log(`ok   ${msg}`);

function start(name, cmd, cmdArgs, env, port) {
	const dataDir = mkdtempSync(path.join(tmpdir(), `pf-visual-${name}-`));
	const child = spawn(cmd, cmdArgs, {
		cwd: SITE,
		env: { ...process.env, ...env, POWERFARM_DATA_DIR: dataDir, EMDASH_PRIVATE_MEDIA: "1", HOST: "127.0.0.1", PORT: String(port) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const log = [];
	child.stdout.on("data", (d) => log.push(String(d)));
	child.stderr.on("data", (d) => log.push(String(d)));
	return {
		base: `http://127.0.0.1:${port}`,
		log,
		async stop() {
			child.kill("SIGTERM");
			await new Promise((r) => setTimeout(r, 500));
			rmSync(dataDir, { recursive: true, force: true });
		},
	};
}

async function waitFor(url, ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
			if (res.status < 500) return;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`${url} did not answer within ${ms / 1000}s`);
}

async function contrast(page, label, enforce) {
	const result = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
	const nodes = result.violations.flatMap((v) => v.nodes);
	report.push({ page: label, contrastProblems: nodes.map((n) => ({ target: n.target.join(" "), summary: n.failureSummary })) });
	if (nodes.length === 0) ok(`${label}: no contrast problems`);
	else if (enforce) fail(`${label}: ${nodes.length} contrast problem(s), first: ${nodes[0].target.join(" ")}`);
	else console.log(`note ${label}: ${nodes.length} contrast finding(s) in EmDash's UI (see report.json)`);
}

async function checkAdmin(page, mode, label) {
	const brand = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-kumo-brand").trim().toLowerCase());
	if (brand === EXPECT[mode].brand) ok(`${label}: Powerfarm theme applied (${mode})`);
	else fail(`${label}: --color-kumo-brand is "${brand}", expected ${EXPECT[mode].brand} (${mode}): theme.css did not reach the admin`);

	const font = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-emdash"));
	if (/Inter/.test(font)) ok(`${label}: Inter is the admin font`);
	else fail(`${label}: --font-emdash is "${font.trim()}", expected Inter`);

	const logo = page.locator('img[src="/brand/mark.svg"]').first();
	if ((await logo.count()) === 0) fail(`${label}: Powerfarm logo not shown`);
	else if (!(await logo.evaluate((img) => img.complete && img.naturalWidth > 0))) fail(`${label}: Powerfarm logo did not load`);
	else ok(`${label}: Powerfarm logo shown`);
}

async function setAdminMode(page, base, mode) {
	await page.goto(`${base}/_emdash/admin`, { waitUntil: "domcontentloaded" });
	await page.evaluate((m) => localStorage.setItem("emdash-theme", m), mode);
}

async function shot(page, name) {
	await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

const browser = await chromium.launch();
try {
	// 1. Production build.
	console.log("\nProduction build (astro.config.node.mjs)");
	const build = spawn(ASTRO, ["build", "--config", "astro.config.node.mjs"], { cwd: SITE, stdio: "inherit" });
	const code = await new Promise((r) => build.on("exit", r));
	if (code !== 0) throw new Error(`production build failed (${code})`);
	const prod = start("prod", process.execPath, ["dist/server/entry.mjs"], {}, 4460);
	try {
		await waitFor(`${prod.base}/`, 60_000);
		for (const mode of ["light", "dark"]) {
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: mode, deviceScaleFactor: 2 });
			const page = await ctx.newPage();

			await page.goto(`${prod.base}/`, { waitUntil: "networkidle" });
			const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
			if (bg === EXPECT[mode].body) ok(`landing: ${mode} background`);
			else fail(`landing: background is ${bg}, expected ${EXPECT[mode].body} (${mode})`);
			await shot(page, `landing-${mode}`);
			await contrast(page, `landing (${mode})`, true);

			await page.goto(`${prod.base}/oidc/continue?rid=not-a-valid-request`, { waitUntil: "networkidle" });
			await page.waitForFunction(() => document.body.dataset.state === "error");
			await shot(page, `oidc-continue-error-${mode}`);
			await contrast(page, `oidc continue (${mode})`, true);

			await setAdminMode(page, prod.base, mode);
			await page.goto(`${prod.base}/_emdash/admin`, { waitUntil: "networkidle" });
			await page.waitForSelector("#emdash-boot-loader", { state: "detached", timeout: 30_000 }).catch(() => {});
			await checkAdmin(page, mode, `admin first screen, production (${page.url().replace(prod.base, "")})`);
			await shot(page, `admin-first-screen-${mode}`);
			await contrast(page, `admin first screen (${mode})`, false);
			await ctx.close();
		}
	} catch (error) {
		console.error(prod.log.join("").slice(-4000));
		throw error;
	} finally {
		await prod.stop();
	}

	// 2. Development server, signed in.
	console.log("\nDevelopment server, signed in through the dev-only setup bypass");
	const dev = start("dev", ASTRO, ["dev", "--config", "astro.config.node.mjs", "--port", "4461", "--host", "127.0.0.1"], {}, 4461);
	try {
		await waitFor(`${dev.base}/`, 180_000);
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
		const page = await ctx.newPage();
		page.setDefaultTimeout(120_000);
		await page.goto(`${dev.base}/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`, { waitUntil: "networkidle" });
		await page.keyboard.press("Escape");
		const screens = [
			["dashboard", "/_emdash/admin"],
			["powerfarm-recovery", "/_emdash/admin/plugins/powerfarm/recovery"],
			["content-list", "/_emdash/admin/content/recovery_operations"],
		];
		for (const mode of ["light", "dark"]) {
			await setAdminMode(page, dev.base, mode);
			for (const [name, url] of screens) {
				await page.goto(`${dev.base}${url}`, { waitUntil: "networkidle" });
				await page.waitForSelector("#emdash-boot-loader", { state: "detached", timeout: 60_000 }).catch(() => {});
				await page.waitForTimeout(500);
				await checkAdmin(page, mode, `${name} (${mode})`);
				await shot(page, `${name}-${mode}`);
				await contrast(page, `${name} (${mode})`, false);
			}
		}
		await ctx.close();
	} catch (error) {
		console.error(dev.log.join("").slice(-4000));
		throw error;
	} finally {
		await dev.stop();
	}
} finally {
	await browser.close();
	writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ failures, pages: report }, null, 2));
}

if (failures.length) {
	console.error(`\n${failures.length} brand check(s) failed. Screenshots and report.json: ${OUT}`);
	process.exit(1);
}
console.log(`\nBrand checks passed. Screenshots and report.json: ${OUT}`);
