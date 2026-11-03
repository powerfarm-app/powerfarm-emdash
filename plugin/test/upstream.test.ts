// The upstream rules: the pin file is well-formed, and linking Powerfarm into
// EmDash's workspace may add Powerfarm importers but never a package.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { compareLockfiles } from "../../scripts/check-lockfile.mjs";

const root = path.join(import.meta.dirname, "..", "..");

const UPSTREAM = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    devDependencies:
      emdash:
        specifier: workspace:*
        version: link:packages/core

packages:

  astro@7.3.2:
    resolution: {integrity: sha512-aaa}

  react@19.2.0:
    resolution: {integrity: sha512-bbb}

snapshots:

  astro@7.3.2(react@19.2.0):
    dependencies:
      react: 19.2.0

  react@19.2.0: {}
`;

const withImporter = (lock: string, name: string) =>
	lock.replace("\npackages:\n", `\n  ${name}:\n    dependencies:\n      astro:\n        specifier: 'catalog:'\n        version: 7.3.2(react@19.2.0)\n\npackages:\n`);

test("the pin names an exact commit, a version and the release tag it builds on", () => {
	const pin = JSON.parse(readFileSync(path.join(root, "upstream", "emdash.json"), "utf8"));
	assert.match(pin.commit, /^[0-9a-f]{40}$/);
	assert.match(pin.version, /^\d+\.\d+\.\d+$/);
	assert.match(pin.basedOnTag, /^emdash@\d+\.\d+\.\d+$/);
	assert.equal(pin.repository, "https://github.com/emdash-cms/emdash.git");
});

test("Powerfarm's importers are allowed; a new package, a changed version or a foreign importer is not", () => {
	assert.equal(compareLockfiles(UPSTREAM, withImporter(UPSTREAM, "powerfarm/plugin")).ok, true);
	const peerVariant = withImporter(UPSTREAM, "powerfarm/site") + "\n  astro@7.3.2(react@19.2.0)(typescript@6.0.3):\n    dependencies:\n      react: 19.2.0\n";
	assert.equal(compareLockfiles(UPSTREAM, peerVariant).ok, true, "a peer variant of a locked package is not a new dependency");

	const newPackage = withImporter(UPSTREAM, "powerfarm/plugin") + "\n  left-pad@1.3.0: {}\n";
	assert.match(compareLockfiles(UPSTREAM, newPackage).problems.join(), /new package "left-pad@1.3.0"/);
	const pkgEntry = withImporter(UPSTREAM, "powerfarm/plugin").replace("\n  react@19.2.0:\n", "\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-zzz}\n\n  react@19.2.0:\n");
	assert.match(compareLockfiles(UPSTREAM, pkgEntry).problems.join(), /new package "left-pad@1.3.0"/);
	const rewritten = withImporter(UPSTREAM, "powerfarm/plugin").replace("    resolution: {integrity: sha512-bbb}", "    resolution: {integrity: sha512-bbb}\n    engines: {node: '>=18'}");
	assert.equal(compareLockfiles(UPSTREAM, rewritten).ok, true, "metadata pnpm adds to a locked package is a note, not a failure");
	const bumped = withImporter(UPSTREAM, "powerfarm/plugin").replace("sha512-bbb", "sha512-ccc");
	assert.match(compareLockfiles(UPSTREAM, bumped).problems.join(), /integrity of "react@19.2.0" changed/);
	assert.match(compareLockfiles(UPSTREAM, withImporter(UPSTREAM, "somewhere/else")).problems.join(), /unexpected new importer/);
});

test("the patches the setup script applies exist and are plain unified diffs against EmDash paths", () => {
	for (const name of ["0001-private-media-files.patch", "0002-plugin-create-references.patch"]) {
		const text = readFileSync(path.join(root, "upstream", "patches", name), "utf8");
		assert.match(text, /^diff --git a\/packages\//m, name);
	}
});
