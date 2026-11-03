// The bridge client and the plugin agree on the wire: signatures for JSON and
// artifact requests, including the signed artifact metadata.
import assert from "node:assert/strict";
import { test } from "node:test";

import { EmDashClient } from "../../mac/bridge/src/client.mjs";
import { artifactSignedRoute, verifyBridgeRequest } from "../src/bridge-auth.ts";

const SECRET = "k".repeat(64);

function capture() {
	const sent: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
	const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: unknown }) => {
		sent.push({ url, headers: init.headers, body: init.body });
		return new Response(JSON.stringify({ success: true, data: { ok: true } }), { status: 200 });
	};
	return { sent, client: new EmDashClient({ baseUrl: "http://emdash.internal:4321", bridgeId: "lab-512-bridge", secret: SECRET, fetchImpl }) };
}

const verify = (headers: Record<string, string>, route: string, body: string | Uint8Array) =>
	verifyBridgeRequest({ headers: new Headers(headers), route, body, expectedBridgeId: "lab-512-bridge", secret: SECRET, claimNonce: async () => true });

test("JSON bridge calls from the real client verify in the plugin", async () => {
	const { sent, client } = capture();
	await client.report("job-1", "progress", { leaseId: "lease-1", opRevision: "rev-1" });
	const req = sent[0]!;
	assert.equal(req.url, "http://emdash.internal:4321/_emdash/api/plugins/powerfarm/bridge/report");
	assert.equal((await verify(req.headers, "powerfarm/bridge/report", req.body as string)).ok, true);
	assert.match(JSON.parse(req.body as string).reportId, /^rep_/);
});

test("artifact uploads verify with their metadata bound into the signature", async () => {
	const { sent, client } = capture();
	const bytes = Buffer.from("restore log contents");
	await client.uploadArtifact({ jobId: "job-1", leaseId: "lease-1", kind: "restore_log", filename: "OP 1.log", contentType: "text/plain", bytes });
	const req = sent[0]!;
	const body = new Uint8Array(req.body as Buffer);
	const headers = new Headers(req.headers);
	assert.equal((await verify(req.headers, artifactSignedRoute(headers), body)).ok, true);
	assert.equal(headers.get("x-powerfarm-filename"), "OP_1.log", "filename sanitised before signing");

	// Changing any metadata header in transit breaks the signature.
	for (const name of ["x-powerfarm-job", "x-powerfarm-lease", "x-powerfarm-kind", "x-powerfarm-sha256", "content-type", "x-powerfarm-filename"]) {
		const tampered = { ...req.headers, [name]: "changed" };
		const result = await verify(tampered, artifactSignedRoute(new Headers(tampered)), body);
		assert.equal(result.ok, false, name);
	}
	// And so does changing the bytes.
	const other = new Uint8Array(Buffer.from("restore log content!"));
	assert.equal((await verify(req.headers, artifactSignedRoute(headers), other)).ok, false);
});
