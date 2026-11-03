import { Loader } from "@cloudflare/kumo";
import * as React from "react";

const TONE: Record<string, string> = {
	trusted: "#1f7a4d",
	verified: "#1f7a4d",
	succeeded: "#1f7a4d",
	server_verified: "#1f7a4d",
	online: "#1f7a4d",
	approved: "#0b62c4",
	recovery_ready: "#0b62c4",
	identified: "#0b62c4",
	restored_unverified: "#9a6700",
	verification_in_progress: "#9a6700",
	restore_authorised: "#9a6700",
	restoring: "#9a6700",
	claimed: "#9a6700",
	running: "#9a6700",
	draft: "#6b7280",
	proposed: "#7c3aed",
	unknown_outcome: "#b42318",
	needs_inspection: "#b42318",
	blocked: "#b42318",
	failed: "#b42318",
	stalled: "#b42318",
	offline: "#b42318",
	unidentified: "#6b7280",
	out_of_scope: "#6b7280",
	revoked: "#6b7280",
	simulated: "#7c3aed",
	dry_run: "#7c3aed",
};

export function Pill({ value }: { value: string | null | undefined }) {
	if (!value) return <span style={{ opacity: 0.5 }}>—</span>;
	const color = TONE[value] ?? "#6b7280";
	return (
		<span style={{ display: "inline-block", padding: "1px 8px", borderRadius: 999, fontSize: 12, border: `1px solid ${color}`, color, whiteSpace: "nowrap" }}>
			{value.replace(/_/g, " ")}
		</span>
	);
}

export function Mono({ children }: { children: React.ReactNode }) {
	return <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}>{children}</span>;
}

export function Muted({ children }: { children: React.ReactNode }) {
	return <span style={{ opacity: 0.7 }}>{children}</span>;
}

export function ErrorText({ error }: { error: string | undefined }) {
	return error ? (
		<p role="alert" style={{ color: "#b42318", margin: 0 }}>
			{error}
		</p>
	) : null;
}

export function KV({ rows }: { rows: Array<[string, React.ReactNode]> }) {
	return (
		<dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px", margin: 0, fontSize: 13 }}>
			{rows.map(([k, v]) => (
				<React.Fragment key={k}>
					<dt style={{ opacity: 0.7 }}>{k}</dt>
					<dd style={{ margin: 0, overflowWrap: "anywhere" }}>{v ?? "—"}</dd>
				</React.Fragment>
			))}
		</dl>
	);
}

export function List({ items, empty }: { items: React.ReactNode[]; empty: string }) {
	if (items.length === 0) return <p style={{ opacity: 0.7, margin: 0, fontSize: 13 }}>{empty}</p>;
	return (
		<ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, fontSize: 13 }}>
			{items.map((item, i) => (
				<li key={i}>{item}</li>
			))}
		</ul>
	);
}

/** Load data once per dependency change; show loader and errors consistently. */
export function useData<T>(load: () => Promise<T>, deps: React.DependencyList, refreshMs?: number) {
	const [data, setData] = React.useState<T>();
	const [error, setError] = React.useState<string>();
	const run = React.useCallback(async () => {
		setError(undefined);
		try {
			setData(await load());
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps);
	React.useEffect(() => {
		void run();
		if (!refreshMs) return;
		const t = window.setInterval(() => void run(), refreshMs);
		return () => window.clearInterval(t);
	}, [run, refreshMs]);
	return { data, error, reload: run };
}

export function Loading({ error }: { error?: string }) {
	return error ? <ErrorText error={error} /> : <Loader />;
}

export const cell: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid rgba(127,127,127,.2)", verticalAlign: "top", textAlign: "left" };
export const head: React.CSSProperties = { ...cell, fontWeight: 600, fontSize: 12, textTransform: "uppercase", opacity: 0.7 };

export function Table({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
	return (
		<div style={{ overflowX: "auto" }}>
			<table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
				<thead>
					<tr>
						{headers.map((h) => (
							<th key={h} style={head}>
								{h}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((r, i) => (
						<tr key={i}>
							{r.map((c, j) => (
								<td key={j} style={cell}>
									{c}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function when(iso: string | null | undefined): string {
	return iso ? new Date(iso).toLocaleString() : "—";
}
