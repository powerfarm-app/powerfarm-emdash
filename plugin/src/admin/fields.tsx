/**
 * Custom field widgets for EmDash's own editor (seed fields opt in with
 * `widget: "powerfarm:<name>"`). They change only how a field is edited; the
 * value is the same JSON the save hooks validate and normalise.
 */
import * as React from "react";

import { call } from "./api.js";
import { Muted } from "./ui.js";

interface FieldWidgetProps {
	value: unknown;
	onChange: (value: unknown) => void;
	label: string;
	id: string;
	required?: boolean;
	minimal?: boolean;
}

const NAMESPACES = ["vat", "lei", "duns", "company_reg", "domain", "email_domain", "github"];

type Row = { namespace: string; value: string };

function rowsOf(value: unknown): Row[] {
	return Array.isArray(value) ? value.filter((r): r is Row => !!r && typeof r === "object").map((r) => ({ namespace: String(r.namespace ?? ""), value: String(r.value ?? "") })) : [];
}

/** One identifier row, with a live registry lookup: who already holds it. */
function IdentifierRow({ row, onChange, onRemove }: { row: Row; onChange: (r: Row) => void; onRemove: () => void }) {
	const [holder, setHolder] = React.useState<string>();
	React.useEffect(() => {
		if (!row.namespace || !row.value.trim()) return setHolder(undefined);
		let live = true;
		const t = window.setTimeout(() => {
			call<{ identifier: string; holder: string | null }>("identity/lookup", { namespace: row.namespace, value: row.value })
				.then((r) => live && setHolder(r.holder ? `${r.identifier} already identifies ${r.holder}` : `${r.identifier} is free`))
				.catch((e: unknown) => live && setHolder(e instanceof Error ? e.message : String(e)));
		}, 400);
		return () => {
			live = false;
			window.clearTimeout(t);
		};
	}, [row.namespace, row.value]);
	const custom = row.namespace.startsWith("ext:") || (row.namespace !== "" && !NAMESPACES.includes(row.namespace));
	return (
		<div style={{ display: "grid", gap: 2 }}>
			<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
				<select value={custom ? "ext:" : row.namespace} onChange={(e) => onChange({ ...row, namespace: (e.target as HTMLSelectElement).value })}>
					<option value="">namespace</option>
					{NAMESPACES.map((n) => (
						<option key={n}>{n}</option>
					))}
					<option value="ext:">ext:&lt;issuer&gt;</option>
				</select>
				{custom && <input aria-label="Issuer namespace" placeholder="ext:issuer" value={row.namespace} onChange={(e) => onChange({ ...row, namespace: (e.target as HTMLInputElement).value })} />}
				<input aria-label="Identifier value" placeholder="value" value={row.value} onChange={(e) => onChange({ ...row, value: (e.target as HTMLInputElement).value })} />
				<button type="button" onClick={onRemove}>
					Remove
				</button>
			</div>
			{holder && <small style={{ color: /already identifies/.test(holder) ? "#b42318" : undefined, opacity: /already/.test(holder) ? 1 : 0.7 }}>{holder}</small>}
		</div>
	);
}

function IdentifiersField({ value, onChange, label, id }: FieldWidgetProps) {
	const rows = rowsOf(value);
	return (
		<div role="group" aria-labelledby={`${id}-label`} style={{ display: "grid", gap: 6 }}>
			<span id={`${id}-label`} style={{ fontWeight: 500 }}>
				{label}
			</span>
			<Muted>Unique across every record type; registered when this record is published. Never put credentials here.</Muted>
			{rows.map((row, i) => (
				<IdentifierRow key={i} row={row} onChange={(r) => onChange(rows.map((x, j) => (j === i ? r : x)))} onRemove={() => onChange(rows.filter((_, j) => j !== i))} />
			))}
			<div>
				<button type="button" id={id} onClick={() => onChange([...rows, { namespace: "", value: "" }])}>
					Add identifier
				</button>
			</div>
		</div>
	);
}

type Ref = { name: string; store: string; reference: string };
const STORES = ["emdash_setting", "password_manager", "vault", "host_file"];

function SecretRefsField({ value, onChange, label, id }: FieldWidgetProps) {
	const rows: Ref[] = Array.isArray(value) ? (value as Ref[]).map((r) => ({ name: String(r?.name ?? ""), store: String(r?.store ?? ""), reference: String(r?.reference ?? "") })) : [];
	const looksSecret = (r: string) => r.length >= 24 && !/[/:#._-]/.test(r);
	return (
		<div role="group" aria-labelledby={`${id}-label`} style={{ display: "grid", gap: 6 }}>
			<span id={`${id}-label`} style={{ fontWeight: 500 }}>
				{label}
			</span>
			<Muted>Where each credential lives — never the credential itself. Saves that contain a secret are refused.</Muted>
			{rows.map((r, i) => (
				<div key={i} style={{ display: "grid", gap: 2 }}>
					<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
						<input aria-label="Name" placeholder="name (db, api…)" value={r.name} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, name: (e.target as HTMLInputElement).value } : x)))} />
						<select aria-label="Store" value={r.store} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, store: (e.target as HTMLSelectElement).value } : x)))}>
							<option value="">store</option>
							{STORES.map((s) => (
								<option key={s}>{s}</option>
							))}
						</select>
						<input aria-label="Reference" placeholder="kv/powerfarm/db" value={r.reference} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, reference: (e.target as HTMLInputElement).value } : x)))} />
						<button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
							Remove
						</button>
					</div>
					{looksSecret(r.reference) && <small style={{ color: "#b42318" }}>This looks like a secret value, not a location. It will be refused.</small>}
				</div>
			))}
			<div>
				<button type="button" id={id} onClick={() => onChange([...rows, { name: "", store: "", reference: "" }])}>
					Add reference
				</button>
			</div>
		</div>
	);
}

export const fields = {
	identifiers: IdentifiersField,
	"secret-refs": SecretRefsField,
};
