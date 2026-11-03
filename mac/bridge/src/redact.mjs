// Redaction applied to logs before they leave the host as evidence.
// Device identifiers stay (they are what the evidence is about); account
// identifiers and anything that looks like a credential is removed.
const RULES = [
	[/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
	[/\+\d[\d ().-]{7,}\d/g, "[phone]"],
	[/\b(?:password|passcode|token|secret|apikey|api_key|authorization)\b\s*[:=]\s*\S+/gi, "[credential]"],
	[/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [credential]"],
	[/\bec_pat_[A-Za-z0-9_-]+/g, "[token]"],
];

export function redact(text) {
	let out = String(text);
	for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
	return out;
}
