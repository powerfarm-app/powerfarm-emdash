#!/usr/bin/env node
// Test stand-in for cfgutil: lists one iPhone, answers `get` with inventory JSON
// that contains an Apple Account email (to test redaction), and runs `backup`
// slowly so shutdown behaviour can be tested. It never touches hardware.
const args = process.argv.slice(2);
const ecid = "0x1A2B3C4D5E6F";
if (args.includes("list")) {
	process.stdout.write(JSON.stringify({ Command: "list", Output: { [ecid]: { ECID: ecid, deviceType: "iPhone14,5" } } }));
	process.exit(0);
}
if (args.includes("get")) {
	process.stdout.write(JSON.stringify({ Command: "get", Output: { [ecid]: { ECID: ecid, serialNumber: "F2LXK0ABCD12", deviceType: "iPhone14,5", firmwareVersion: "18.2", buildVersion: "22C152" } } }));
	process.stderr.write("signed in as someone@example.com token=abc123\n");
	process.exit(0);
}
if (args.includes("backup")) {
	setTimeout(() => process.exit(0), Number(process.env.STUB_BACKUP_MS ?? 50));
} else {
	process.stderr.write(`stub refuses: ${args.join(" ")}\n`);
	process.exit(64);
}
