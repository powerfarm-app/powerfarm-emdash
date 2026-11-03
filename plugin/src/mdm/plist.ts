/**
 * Apple XML property lists, the wire format of the MDM protocol.
 *
 * Devices send XML plists in check-in and command-result messages; the server
 * answers commands with XML plists. Binary plists are not used by the MDM
 * protocol and are refused. Values map to JS as: dict → object, array → array,
 * string → string, integer/real → number (integers outside 2^53 → string),
 * true/false → boolean, date → Date, data → Uint8Array.
 */

export type PlistValue = string | number | boolean | Date | Uint8Array | PlistValue[] | { [key: string]: PlistValue };
export type PlistDict = { [key: string]: PlistValue };

const MAX_DEPTH = 32;
const MAX_NODES = 200_000;

export class PlistError extends Error {}

interface Node {
	name: string;
	children: Node[];
	text: string;
}

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
		if (e === "lt") return "<";
		if (e === "gt") return ">";
		if (e === "amp") return "&";
		if (e === "quot") return '"';
		if (e === "apos") return "'";
		const code = e.startsWith("#x") ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
		if (!Number.isFinite(code) || code > 0x10ffff) throw new PlistError("Invalid character reference");
		return String.fromCodePoint(code);
	});
}

/** A small, strict XML reader for the plist subset: elements and text, no attributes we need, no entities beyond the five. */
function parseXml(xml: string): Node {
	let i = 0;
	let nodes = 0;
	const root: Node = { name: "#root", children: [], text: "" };
	const stack: Node[] = [root];
	while (i < xml.length) {
		const lt = xml.indexOf("<", i);
		if (lt < 0) {
			stack.at(-1)!.text += xml.slice(i);
			break;
		}
		if (lt > i) stack.at(-1)!.text += xml.slice(i, lt);
		if (xml.startsWith("<?", lt)) {
			const end = xml.indexOf("?>", lt);
			if (end < 0) throw new PlistError("Unterminated processing instruction");
			i = end + 2;
		} else if (xml.startsWith("<!--", lt)) {
			const end = xml.indexOf("-->", lt);
			if (end < 0) throw new PlistError("Unterminated comment");
			i = end + 3;
		} else if (xml.startsWith("<!DOCTYPE", lt)) {
			// The plist DOCTYPE has no internal subset; refuse one (no entity expansion).
			const end = xml.indexOf(">", lt);
			if (end < 0 || xml.slice(lt, end).includes("[")) throw new PlistError("Unsupported DOCTYPE");
			i = end + 1;
		} else if (xml.startsWith("<![CDATA[", lt)) {
			const end = xml.indexOf("]]>", lt);
			if (end < 0) throw new PlistError("Unterminated CDATA");
			stack.at(-1)!.text += xml.slice(lt + 9, end);
			i = end + 3;
		} else if (xml[lt + 1] === "/") {
			const end = xml.indexOf(">", lt);
			if (end < 0) throw new PlistError("Unterminated end tag");
			const name = xml.slice(lt + 2, end).trim();
			const open = stack.pop();
			if (!open || open.name !== name) throw new PlistError(`Mismatched </${name}>`);
			i = end + 1;
		} else {
			const end = xml.indexOf(">", lt);
			if (end < 0) throw new PlistError("Unterminated tag");
			let inner = xml.slice(lt + 1, end);
			const selfClosing = inner.endsWith("/");
			if (selfClosing) inner = inner.slice(0, -1);
			const name = inner.trim().split(/\s+/, 1)[0]!;
			if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new PlistError(`Invalid tag <${name}>`);
			if (++nodes > MAX_NODES) throw new PlistError("Plist too large");
			const node: Node = { name, children: [], text: "" };
			stack.at(-1)!.children.push(node);
			if (!selfClosing) {
				if (stack.length > MAX_DEPTH + 2) throw new PlistError("Plist nested too deeply");
				stack.push(node);
			}
			i = end + 1;
		}
	}
	if (stack.length !== 1) throw new PlistError("Unclosed element");
	return root;
}

function base64ToBytes(s: string): Uint8Array {
	const clean = s.replace(/\s+/g, "");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new PlistError("Invalid base64 in <data>");
	const bin = atob(clean);
	const out = new Uint8Array(bin.length);
	for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
	return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
	let bin = "";
	for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
	return btoa(bin);
}

function value(node: Node): PlistValue {
	const text = decodeEntities(node.text);
	switch (node.name) {
		case "dict": {
			const out: PlistDict = {};
			const c = node.children;
			if (c.length % 2) throw new PlistError("<dict> needs key/value pairs");
			for (let k = 0; k < c.length; k += 2) {
				if (c[k]!.name !== "key") throw new PlistError("<dict> entries must start with <key>");
				const key = decodeEntities(c[k]!.text);
				if (key === "__proto__" || key === "constructor" || key === "prototype") throw new PlistError("Forbidden key");
				out[key] = value(c[k + 1]!);
			}
			return out;
		}
		case "array":
			return node.children.map(value);
		case "string":
			return text;
		case "integer": {
			const t = text.trim();
			if (!/^[+-]?\d+$/.test(t)) throw new PlistError("Invalid <integer>");
			const n = Number(t);
			return Number.isSafeInteger(n) ? n : t;
		}
		case "real": {
			const n = Number(text.trim());
			if (!Number.isFinite(n)) throw new PlistError("Invalid <real>");
			return n;
		}
		case "true":
			return true;
		case "false":
			return false;
		case "date": {
			const d = new Date(text.trim());
			if (Number.isNaN(d.getTime())) throw new PlistError("Invalid <date>");
			return d;
		}
		case "data":
			return base64ToBytes(text);
		default:
			throw new PlistError(`Unsupported element <${node.name}>`);
	}
}

/** Parse an XML plist document (bytes or text). Binary plists are refused. */
export function parsePlist(input: Uint8Array | string): PlistValue {
	const xml = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
	if (xml.startsWith("bplist")) throw new PlistError("Binary plists are not accepted");
	const root = parseXml(xml);
	const plist = root.children.find((n) => n.name === "plist");
	if (!plist || plist.children.length !== 1) throw new PlistError("Not a plist document");
	return value(plist.children[0]!);
}

export function parsePlistDict(input: Uint8Array | string): PlistDict {
	const v = parsePlist(input);
	if (!v || typeof v !== "object" || Array.isArray(v) || v instanceof Date || v instanceof Uint8Array) throw new PlistError("Expected a <dict>");
	return v;
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function emit(v: PlistValue, indent: string): string {
	const next = `${indent}\t`;
	if (typeof v === "string") return `${indent}<string>${esc(v)}</string>`;
	if (typeof v === "boolean") return `${indent}<${v}/>`;
	if (typeof v === "number") {
		if (!Number.isFinite(v)) throw new PlistError("Cannot encode a non-finite number");
		return Number.isInteger(v) ? `${indent}<integer>${v}</integer>` : `${indent}<real>${v}</real>`;
	}
	if (v instanceof Date) return `${indent}<date>${v.toISOString().replace(/\.\d{3}Z$/, "Z")}</date>`;
	if (v instanceof Uint8Array) return `${indent}<data>${bytesToBase64(v)}</data>`;
	if (Array.isArray(v)) return v.length ? `${indent}<array>\n${v.map((x) => emit(x, next)).join("\n")}\n${indent}</array>` : `${indent}<array/>`;
	const keys = Object.keys(v).filter((k) => v[k] !== undefined);
	if (!keys.length) return `${indent}<dict/>`;
	return `${indent}<dict>\n${keys.map((k) => `${next}<key>${esc(k)}</key>\n${emit(v[k]!, next)}`).join("\n")}\n${indent}</dict>`;
}

export function buildPlist(v: PlistValue): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${emit(v, "")}\n</plist>\n`;
}
