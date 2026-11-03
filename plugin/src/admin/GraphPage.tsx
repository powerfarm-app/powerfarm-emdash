/**
 * Graph workspace, entity-centred: open one entity and explore outwards.
 * Views: Explorer (relationships), Dependencies (bounded trace), History
 * (journal), Provenance; presets narrow to the operational or research graph.
 * Nothing loads the whole graph; every view pages from the server.
 */
import { Button } from "@cloudflare/kumo";
import * as React from "react";

import { call, type Neighbour, type NodeView } from "./api.js";
import { ErrorText, KV, List, Loading, Mono, Muted, Pill, when } from "./ui.js";

const COLORS: Record<string, string> = {
	mission: "#7c3aed",
	asset: "#0b62c4",
	procedure: "#1f7a4d",
	operation: "#c2410c",
	job: "#b45309",
	event: "#6b7280",
	journal_event: "#6b7280",
	evidence: "#a16207",
	software: "#0e7490",
	research: "#be185d",
	person: "#4d7c0f",
	project: "#4338ca",
	requirement: "#4338ca",
	decision: "#4338ca",
	test: "#4338ca",
	release: "#4338ca",
	bridge: "#b45309",
	lease: "#b45309",
	reconciliation: "#b42318",
};

const PRESETS: Record<string, { label: string; nodeTypes?: string[] }> = {
	all: { label: "Everything" },
	operational: { label: "Operational", nodeTypes: ["asset", "operation", "job", "evidence", "event", "journal_event", "bridge", "lease", "procedure", "reconciliation"] },
	research: { label: "Research", nodeTypes: ["research", "procedure", "asset", "software", "project", "requirement", "decision"] },
	engineering: { label: "Engineering", nodeTypes: ["project", "requirement", "decision", "software", "test", "release"] },
};

/** Radial view of one node and its visible neighbours: O(n), readable at any graph size. */
function Radial({ center, neighbours, onOpen }: { center: NodeView; neighbours: Neighbour[]; onOpen: (id: string) => void }) {
	const size = 420;
	const r = 160;
	const shown = neighbours.slice(0, 36);
	return (
		<svg viewBox={`0 0 ${size} ${size}`} style={{ width: "100%", maxWidth: size, border: "1px solid rgba(127,127,127,.25)", borderRadius: 8 }} role="img" aria-label={`Relationships of ${center.title}`}>
			{shown.map((n, i) => {
				const a = (2 * Math.PI * i) / Math.max(shown.length, 1);
				const x = size / 2 + r * Math.cos(a);
				const y = size / 2 + r * Math.sin(a);
				return (
					<g key={n.edge.id} onClick={() => onOpen(n.node.id)} style={{ cursor: "pointer" }}>
						<line x1={size / 2} y1={size / 2} x2={x} y2={y} stroke="rgba(127,127,127,.5)" strokeDasharray={n.edge.state === "proposed" ? "4 3" : n.edge.state === "historical" ? "1 3" : undefined} />
						<circle cx={x} cy={y} r={7} fill={COLORS[n.node.type] ?? "#888"} />
						<text x={x + (Math.cos(a) >= 0 ? 10 : -10)} y={y + 4} fontSize={10} fill="currentColor" textAnchor={Math.cos(a) >= 0 ? "start" : "end"}>
							{(n.node.key ?? n.node.title).slice(0, 22)}
						</text>
					</g>
				);
			})}
			<circle cx={size / 2} cy={size / 2} r={11} fill={COLORS[center.type] ?? "#888"} />
			<text x={size / 2} y={size / 2 + 26} fontSize={12} fill="currentColor" textAnchor="middle">
				{(center.key ?? center.title).slice(0, 30)}
			</text>
		</svg>
	);
}

type Tab = "explorer" | "dependencies" | "history" | "provenance";

export function GraphPage() {
	const [query, setQuery] = React.useState("");
	const [results, setResults] = React.useState<NodeView[]>([]);
	const [nodeId, setNodeId] = React.useState<string | null>(() => new URLSearchParams(window.location.search).get("node"));
	const [tab, setTab] = React.useState<Tab>("explorer");
	const [preset, setPreset] = React.useState("all");
	const [drafts, setDrafts] = React.useState(false);
	const [node, setNode] = React.useState<NodeView | null>(null);
	const [neighbours, setNeighbours] = React.useState<Neighbour[]>([]);
	const [cursor, setCursor] = React.useState<string | undefined>();
	const [total, setTotal] = React.useState(0);
	const [selectedEdge, setSelectedEdge] = React.useState<Neighbour | null>(null);
	const [detail, setDetail] = React.useState<unknown>(null);
	const [error, setError] = React.useState<string>();
	const nodeTypes = PRESETS[preset]!.nodeTypes;

	const search = async () => {
		setError(undefined);
		try {
			setResults((await call<{ results: NodeView[] }>("graph/search", { query, limit: 20, includeDrafts: drafts })).results);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const open = React.useCallback(
		async (id: string, more?: string) => {
			setError(undefined);
			setSelectedEdge(null);
			try {
				const page = await call<{ node: NodeView; neighbours: Neighbour[]; total: number; cursor?: string }>("graph/neighbours", { node: id, nodeTypes, cursor: more, limit: 50, includeDrafts: drafts });
				setNode(page.node);
				setNeighbours((prev) => (more ? [...prev, ...page.neighbours] : page.neighbours));
				setCursor(page.cursor);
				setTotal(page.total);
				setNodeId(id);
				const url = new URL(window.location.href);
				url.searchParams.set("node", id);
				window.history.replaceState(null, "", url);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[drafts, nodeTypes],
	);

	React.useEffect(() => {
		if (nodeId) void open(nodeId);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [preset, drafts]);

	React.useEffect(() => {
		if (!nodeId || tab === "explorer") return;
		setDetail(null);
		const route = tab === "dependencies" ? "graph/trace" : tab === "history" ? "graph/history" : "graph/provenance";
		call(route, { node: nodeId, depth: 3, direction: "out", nodeTypes, includeDrafts: drafts })
			.then(setDetail)
			.catch((e) => setError(e instanceof Error ? e.message : String(e)));
	}, [tab, nodeId, nodeTypes, drafts]);

	return (
		<section style={{ display: "grid", gap: 16 }}>
			<header>
				<h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Powerfarm Graph</h1>
				<p style={{ margin: "4px 0 0", opacity: 0.75 }}>Open an entity and explore its relationships. Solid: published. Dashed: proposed in a draft. Dotted: history.</p>
			</header>

			<form
				onSubmit={(e) => {
					e.preventDefault();
					void search();
				}}
				style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
			>
				<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="LAB-8GB, OP-0007, restore notes…" aria-label="Search" style={{ padding: "6px 10px", minWidth: 260, borderRadius: 6, border: "1px solid rgba(127,127,127,.4)", background: "transparent", color: "inherit" }} />
				<Button type="submit">Search</Button>
				<select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Graph">
					{Object.entries(PRESETS).map(([k, p]) => (
						<option key={k} value={k}>
							{p.label}
						</option>
					))}
				</select>
				<label style={{ fontSize: 13 }}>
					<input type="checkbox" checked={drafts} onChange={(e) => setDrafts(e.target.checked)} /> Include drafts (editors)
				</label>
			</form>
			<ErrorText error={error} />
			{results.length > 0 && (
				<List
					empty=""
					items={results.map((r) => (
						<button key={r.id} type="button" onClick={() => void open(r.id)} style={{ background: "none", border: 0, padding: 0, color: "inherit", cursor: "pointer", textAlign: "left" }}>
							<Pill value={r.type} /> <strong>{r.key ?? r.title}</strong> {r.key && <Muted>{r.title}</Muted>}
						</button>
					))}
				/>
			)}

			{node && (
				<div style={{ display: "grid", gridTemplateColumns: "minmax(0, 420px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
					<div style={{ display: "grid", gap: 8 }}>
						<Radial center={node} neighbours={neighbours} onOpen={(id) => void open(id)} />
						<div>
							<Pill value={node.type} /> <strong>{node.title}</strong> {node.key && <Mono>{node.key}</Mono>} <Pill value={node.state === "draft" ? "draft" : node.status} />
						</div>
						{node.adminUrl && <a href={node.adminUrl}>Open in editor →</a>}
						{node.data && (
							<details>
								<summary>Fields</summary>
								<KV rows={Object.entries(node.data).slice(0, 30).map(([k, v]) => [k, typeof v === "object" ? <Mono key={k}>{JSON.stringify(v)?.slice(0, 200)}</Mono> : String(v ?? "—")])} />
							</details>
						)}
					</div>
					<div style={{ display: "grid", gap: 8 }}>
						<div role="tablist" style={{ display: "flex", gap: 6 }}>
							{(["explorer", "dependencies", "history", "provenance"] as Tab[]).map((t) => (
								<Button key={t} type="button" variant={tab === t ? "primary" : "ghost"} onClick={() => setTab(t)}>
									{t === "explorer" ? "Relationships" : t[0]!.toUpperCase() + t.slice(1)}
								</Button>
							))}
						</div>
						{tab === "explorer" && (
							<>
								<Muted>
									{neighbours.length} of {total} relationships
								</Muted>
								<List
									empty="No visible relationships."
									items={neighbours.map((n) => (
										<span key={n.edge.id}>
											<button type="button" onClick={() => setSelectedEdge(n)} style={{ background: "none", border: 0, padding: 0, color: "inherit", cursor: "pointer", opacity: 0.75 }}>
												{n.direction === "out" ? "→" : "←"} {n.edge.label}
											</button>{" "}
											<button type="button" onClick={() => void open(n.node.id)} style={{ background: "none", border: 0, padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer" }}>
												{n.node.key ?? n.node.title}
											</button>{" "}
											<Pill value={n.node.type} /> {n.edge.state !== "published" && <Pill value={n.edge.state} />}
										</span>
									))}
								/>
								{cursor && (
									<Button type="button" variant="secondary" onClick={() => void open(nodeId!, cursor)}>
										Load more
									</Button>
								)}
								{selectedEdge && (
									<div style={{ border: "1px solid rgba(127,127,127,.3)", borderRadius: 8, padding: 10 }}>
										<strong>Relationship</strong>
										<KV
											rows={[
												["Type", <Mono key="t">{selectedEdge.edge.type}</Mono>],
												["From", <Mono key="f">{selectedEdge.edge.from}</Mono>],
												["To", <Mono key="to">{selectedEdge.edge.to}</Mono>],
												["Source", selectedEdge.edge.source],
												["State", selectedEdge.edge.state],
												["Recorded", when(selectedEdge.edge.recordedAt)],
												["Origin", <Mono key="o">{selectedEdge.edge.origin}</Mono>],
											]}
										/>
									</div>
								)}
							</>
						)}
						{tab !== "explorer" && (detail ? <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 520, overflow: "auto" }}>{JSON.stringify(detail, null, 2)}</pre> : <Loading />)}
					</div>
				</div>
			)}
		</section>
	);
}
