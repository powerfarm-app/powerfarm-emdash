// Powerfarm's brand settings for EmDash, shared by astro.config.mjs (Cloudflare)
// and astro.config.node.mjs. docs/BRAND.md lists every place the brand is set.
import { fontProviders } from "astro/config";

// emdash({ admin }): the admin's logo (login, setup and sidebar), its name
// (sidebar, browser tab, loading screen), the sidebar footer and the favicon.
// Files live in public/; the logo is a black tile, so it reads on cream and on black.
export const admin = {
	siteName: "Powerfarm",
	logo: "/brand/mark.svg",
	favicon: "/favicon.svg",
	footerLabel: "Powerfarm",
};

// Inter for the admin and Powerfarm's pages. EmDash's own font (Noto Sans) is
// switched off with emdash({ fonts: false }) and Inter takes its CSS variable,
// --font-emdash, as EmDash's admin stylesheet documents. The Astro Font API
// downloads the files at build time and serves them from the site itself.
export const fonts = [
	{
		provider: fontProviders.google(),
		name: "Inter",
		cssVariable: "--font-emdash",
		weights: ["100 900"],
		styles: ["normal", "italic"],
		subsets: ["latin", "latin-ext", "cyrillic", "cyrillic-ext", "greek", "greek-ext", "vietnamese"],
		fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
	},
];
