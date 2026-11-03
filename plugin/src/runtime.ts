/**
 * Access to the read port. Production opens a port over EmDash's database
 * handle for the current request (see KyselyReadPort.open: on Cloudflare the
 * handle is the request's D1 session and must not be reused across requests);
 * tests install an adapter over a real SQLite schema.
 */

import { ContentReader } from "./content.js";
import { type EmDashReadPort, KyselyReadPort } from "./emdash-port.js";

let factory: () => Promise<EmDashReadPort> = () => KyselyReadPort.open();

export function setReadPortFactory(next: () => Promise<EmDashReadPort>): void {
	factory = next;
}

export async function getReader(defaultLocale = "en"): Promise<ContentReader> {
	return new ContentReader(await factory(), defaultLocale);
}
