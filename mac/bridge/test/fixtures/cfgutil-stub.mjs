#!/usr/bin/env node
// Stands in for cfgutil in tests. Lists one iPhone; refuses everything else.
const args = process.argv.slice(2);
if (args.includes("list")) {
	process.stdout.write(JSON.stringify({ Command: "list", Output: { "0x1A2B3C4D5E": { ECID: "0x1A2B3C4D5E", deviceType: "iPhone14,5" } } }));
	process.exit(0);
}
process.stderr.write(`stub refuses: ${args.join(" ")}\n`);
process.exit(64);
