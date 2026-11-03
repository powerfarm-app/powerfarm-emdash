// Minimal stand-ins for the value exports of "emdash" that the plugin imports.
// Tests run without EmDash's npm dependencies; behaviour here mirrors the real classes' contracts.
export class ContentSaveRejectedError extends Error {
	override readonly name = "ContentSaveRejectedError";
}
export class PluginRouteError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
}
export function definePlugin<T>(definition: T): T {
	return definition;
}
export function definePluginRoute<T>(route: T): T {
	return route;
}

/** Mirrors emdash's pluginResponse(): the wire shape raw routes return. */
export function pluginResponse(init: { status?: number; headers?: Record<string, string>; body?: unknown } = {}) {
	const headers: Array<[string, string]> = [];
	new Headers(init.headers).forEach((value, name) => headers.push([name, value]));
	return { __emdashPluginResponse: true, status: init.status ?? 200, headers, body: init.body ?? null };
}
