// Maps "./x.js" imports to "./x.ts" so node can load the plugin's TypeScript sources in tests.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STUBS = { emdash: new URL("./stubs/emdash.ts", import.meta.url).href };

export async function resolve(spec, ctx, next) {
	if (Object.hasOwn(STUBS, spec)) return next(STUBS[spec], ctx);
	// Route tests import astro/zod (Astro's zod 4, a devDependency). Where node_modules
	// are not installed, POWERFARM_ZOD may point at any zod 4 entry file instead.
	if (spec === "astro/zod" && process.env.POWERFARM_ZOD) return next(new URL(`file://${process.env.POWERFARM_ZOD}`).href, ctx);
	if (spec.endsWith(".js") && ctx.parentURL?.startsWith("file:")) {
		const url = new URL(spec.replace(/\.js$/, ".ts"), ctx.parentURL);
		if (existsSync(fileURLToPath(url))) return next(url.href, ctx);
	}
	return next(spec, ctx);
}
