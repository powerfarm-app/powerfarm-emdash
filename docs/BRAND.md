# Powerfarm brand on EmDash

Powerfarm's look is black and cream, with orange and pink as accents and amber kept for small details. The brand is applied without changing EmDash: only through the settings EmDash offers, one stylesheet loaded with the plugin, and Powerfarm's own pages.

The v0.5.1 brand files from the old `powerfarm-identity` repository are a reference only. The symbol (a diamond with a bolt), the wordmark, the black and cream, and the square, quick, plain style come from there. Amber as the colour of every button does not.

## Colours and what they mean

| Role | On black (dark) | On cream (light) | Used for |
| --- | --- | --- | --- |
| Base | black `#080702` | cream `#F8DFC1` | Backgrounds. Every surface, line and grey is a mix of the two. |
| Text | cream `#F8DFC1` | black `#080702` | Body text. Secondary text: `#A8977F` on black, `#5C5244` on cream. |
| Action: ember | `#FF6A1F` | deep `#A83A08` | Primary actions, focus, links, selection. |
| Attention: signal pink | `#FF5C93` | deep `#A61E52` | A person must act: "needs your signature", sign actions. Always with a word or an icon. |
| Detail: amber | `#FFB02E` | deep `#8A5300` | Status dots, thin rules, seals, warnings. Never a button or a background. |
| Error | `#E5484D` | `#B3261E` | Errors and destructive actions, always with an icon or a word. |

### Contrast rules

These rules come from measured contrast ratios:
- **Orange on cream is too faint for a button** (2.2:1), so buttons on cream are black.
- **Ember and pink are almost equally bright** (1.12:1), so they are never told apart by colour alone.
- **Amber on cream** is used only in its deep tone (4.9:1).

### Inside EmDash's admin

The admin uses EmDash's design system (Kumo), which paints primary buttons in its brand colour with white text that cannot be changed. So the brand colour is set to suit white text:
- **Light mode:** black. Black buttons on cream match the rule above.
- **Dark mode:** deep ember, not bright ember, so that white text stays at 4.6:1 or better.

Bright ember carries links and focus in dark mode. Powerfarm's own pages, and later the Identity App, use bright ember with black text instead.

## Where the brand is set

| What | Where | Reaches |
| --- | --- | --- |
| Admin name, logo, favicon, sidebar footer | `site/brand.mjs` → `emdash({ admin })` in both Astro configs | The sign-in, setup and invite screens; the sidebar; the browser tab; the loading screen. |
| Font: Inter | `site/brand.mjs` → Astro `fonts` on `--font-emdash`, with `emdash({ fonts: false })` | All of the admin and Powerfarm's pages. Inter is downloaded at build time and served from the site, as EmDash does with its default font. |
| Admin colours, light and dark | `plugin/src/admin/theme.css`, imported by the plugin's admin entry | Every admin screen, including EmDash's own. Inside the admin, the colours follow EmDash's own light/dark switch. |
| Brand tokens for Powerfarm's pages | `plugin/src/brand/tokens.css` (`@powerfarm/emdash-plugin/brand/tokens.css`) | `/` and `/oidc/continue`. On these pages, the colours follow the system's light or dark setting. |
| Symbol and wordmark | `site/public/brand/mark.svg` (black tile), `site/public/favicon.svg`, `site/src/components/Mark.astro`, `site/src/components/Wordmark.astro` | The admin logo, the favicon, and Powerfarm's pages. |

### Still to set: the site title

**The site title** is not set here yet. It is the title typed into EmDash's setup wizard on the first visit, and it is stored in the database, not in code. EmDash uses it as:
- the name shown when someone saves a passkey;
- the sender name on e-mails.

Choose it before the first setup on Cloudflare.

## How it is checked

CI's *Build on pinned EmDash* job runs `scripts/visual-check.mjs` after the build. It opens the site in Chromium, using EmDash's own Playwright, in light and dark modes:
- **A production build:** Powerfarm's two pages and the admin's sign-in screen.
- **The development server, signed in** through EmDash's dev-only setup bypass: the dashboard, the Recovery page and a content list.

### The check fails if

- **a page lacks Powerfarm's admin colours**, which would mean the stylesheet did not reach it;
- **Inter is not the admin font**;
- **the logo does not load**;
- **axe finds a contrast problem on Powerfarm's own pages.**

Contrast findings in EmDash's own screens are listed in `report.json`, not failed.

The screenshots and `report.json` are attached to every CI run as the *brand-screenshots* artifact.

## When EmDash changes

The theme depends on the names of Kumo's colour variables and on EmDash's `data-theme="classic"` / `data-mode` attributes.

If an EmDash upgrade renames them, the browser check fails in the upgrade PR, before anything ships ([UPSTREAM.md](UPSTREAM.md)). To fix it, map the new names in `theme.css`.
