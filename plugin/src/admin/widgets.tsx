/** Dashboard widgets. All read one shared `dashboard` request. */
import * as React from "react";

import { contentUrl, type Dashboard, pluginPage, sharedCall } from "./api.js";
import { List, Loading, Mono, Muted, Pill, useData, when } from "./ui.js";

function useDashboard() {
	return useData(() => sharedCall<Dashboard>("dashboard", {}, 15_000), [], 30_000);
}

function MissionWidget() {
	const { data, error } = useDashboard();
	if (!data) return <Loading error={error} />;
	const m = data.mission;
	return (
		<div style={{ display: "grid", gap: 8, fontSize: 13 }}>
			<div style={{ fontSize: 22, fontWeight: 600 }}>
				{m.trusted} / {m.targets} trusted
			</div>
			<Muted>{m.complete ? "Mission 001 acceptance criteria met." : "Mission 001 is not complete."}</Muted>
			<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
				{Object.entries(m.statusCounts).map(([s, n]) => (
					<span key={s}>
						<Pill value={s} /> {n}
					</span>
				))}
			</div>
			<List
				empty="No assets."
				items={data.readiness.map((a) => (
					<span key={a.assetTag}>
						{a.title} <Pill value={a.status} />
						{!a.inMission && a.role !== "comms_terminal" ? <Muted> (not in mission scope)</Muted> : null}
					</span>
				))}
			/>
			<a href={pluginPage("/recovery")}>Open Recovery →</a>
		</div>
	);
}

function PhysicalWidget() {
	const { data, error } = useDashboard();
	if (!data) return <Loading error={error} />;
	return (
		<List
			empty="Nothing is waiting for a person."
			items={data.physicalActions.map((a) => (
				<span key={a.assetTag}>
					<strong>{a.assetTag}</strong>: {a.action} {a.procedureCode && <Mono>{a.procedureCode}</Mono>}
				</span>
			))}
		/>
	);
}

function AttentionWidget() {
	const { data, error } = useDashboard();
	if (!data) return <Loading error={error} />;
	return (
		<div style={{ display: "grid", gap: 8 }}>
			<List
				empty="No jobs need inspection."
				items={data.needsInspection.map((j) => (
					<span key={j.id}>
						<Pill value="needs_inspection" /> <a href={pluginPage("/recovery", { job: j.id })}>{j.opCode}</a> {j.operation} on {j.assetTag}
					</span>
				))}
			/>
			<List
				empty="Nothing failed or blocked."
				items={data.failed.map((f, i) => (
					<span key={i}>
						<strong>{f.ref}</strong>: {f.detail}
					</span>
				))}
			/>
		</div>
	);
}

function ApprovalsWidget() {
	const { data, error } = useDashboard();
	if (!data) return <Loading error={error} />;
	return (
		<List
			empty="No drafts awaiting approval."
			items={data.pendingApprovals.map((p) => (
				<span key={p.id}>
					<a href={contentUrl("recovery_operations", p.id)}>{p.opCode ?? p.title}</a> {String(p.assetTag ?? "")}
					{p.preparedByAi ? <Muted> · prepared by an AI client</Muted> : null}
				</span>
			))}
		/>
	);
}

function BridgeWidget() {
	const { data, error } = useDashboard();
	if (!data) return <Loading error={error} />;
	return (
		<List
			empty="No bridge has reported yet. Run powerfarm-bridge doctor on LAB 512."
			items={data.bridges.map((b) => (
				<span key={b.id}>
					<Mono>{b.id}</Mono> <Pill value={String(b.status)} /> {String(b.version ?? "")} {b.mode === "simulated" ? <Pill value="simulated" /> : null}
					<br />
					<Muted>
						Last seen {when(String(b.lastSeenAt ?? ""))}. Validated: {Array.isArray(b.validated) && b.validated.length ? (b.validated as string[]).join(", ") : "none"}
					</Muted>
				</span>
			))}
		/>
	);
}

function EvidenceWidget() {
	const { data, error } = useDashboard();
	if (!data) return <Loading error={error} />;
	const a = data.audit;
	return (
		<div style={{ display: "grid", gap: 8, fontSize: 13 }}>
			<div>
				Audit journal: <Pill value={a.degraded ? "blocked" : "verified"} /> {a.degraded ? <a href={pluginPage("/audit")}>Review</a> : <Muted>intact</Muted>}
			</div>
			<Muted>
				Projection backlog {a.projectionBacklog} · jobs with audit gaps {a.jobsWithAuditGaps}
			</Muted>
			<List
				empty="No evidence missing."
				items={data.missingEvidence.map((m, i) => (
					<span key={i}>
						<strong>{m.ref}</strong>: {m.detail}
					</span>
				))}
			/>
		</div>
	);
}

function EventsWidget() {
	const { data, error } = useDashboard();
	if (!data) return <Loading error={error} />;
	return (
		<List
			empty="No events yet."
			items={data.recent.map((e, i) => (
				<span key={i}>
					<Muted>{when(e.at)}</Muted> <Mono>{e.type}</Mono> {e.title}
				</span>
			))}
		/>
	);
}

interface EntitySummary {
	counts: Record<string, Record<string, number>>;
	runsNeedingAttention: number;
	openWorkItems: number;
	openRuns: number;
	schema: { ok: boolean; missing: string[] };
}

function EntitiesWidget() {
	const { data, error } = useData<EntitySummary>(() => sharedCall<EntitySummary>("entities/summary", {}, 30_000), [], 60_000);
	if (!data) return <Loading error={error} />;
	if (!data.schema.ok) return <p style={{ color: "#b42318", margin: 0 }}>The 1.2 content model is not installed. Run scripts/migrate-1.2.sh.</p>;
	return (
		<div style={{ display: "grid", gap: 6, fontSize: 13 }}>
			{(Object.entries(data.counts) as Array<[string, Record<string, number>]>).map(([collection, counts]) => (
				<div key={collection}>
					<strong>{collection.replace(/_/g, " ")}</strong>{" "}
					{Object.keys(counts).length === 0 ? (
						<Muted>none</Muted>
					) : (
						(Object.entries(counts) as Array<[string, number]>).map(([state, n]) => (
							<span key={state} style={{ marginRight: 6 }}>
								<Pill value={state} /> {n}
							</span>
						))
					)}
				</div>
			))}
			<div>
				{data.openRuns} onboarding run(s) open · <a href={contentUrl("work_items")}>{data.openWorkItems} open work item(s)</a>
				{data.runsNeedingAttention > 0 && <span style={{ color: "#b42318" }}> · {data.runsNeedingAttention} need an administrator</span>}
			</div>
		</div>
	);
}

interface WorkList {
	items: Array<{ id: string; code: string | null; title: string; kind: string; subject: string | null; dueAt: string | null; requiredRole: number | null; adminUrl: string }>;
}

/** Open work items, approvals first: each opens in EmDash's editor, where it is resolved. */
function WorkWidget() {
	const { data, error } = useData<WorkList>(() => sharedCall<WorkList>("automation/work", {}, 15_000), [], 30_000);
	if (!data) return <Loading error={error} />;
	const order = (k: string) => (k === "attention" ? 0 : k === "approval" ? 1 : 2);
	const items = [...data.items].sort((a, b) => order(a.kind) - order(b.kind)).slice(0, 12);
	return (
		<List
			empty="Nothing open."
			items={items.map((w) => (
				<span key={w.id}>
					<Pill value={w.kind} /> <a href={w.adminUrl}>{w.code ?? w.id}</a> {w.title} {w.subject && <Mono>{w.subject}</Mono>} {w.dueAt && <Muted>due {when(w.dueAt)}</Muted>}
				</span>
			))}
		/>
	);
}

interface DeviceRow {
	udid: string;
	assetTag: string;
	productName: string | null;
	osVersion: string | null;
	status: string;
	lastSeenAt: string;
	push: boolean;
	score: number;
	openIncidents: number;
}

/** Powerfarm MDM: every managed device, its posture score (what Cloudflare Access sees) and open incidents. */
function DevicesWidget() {
	const { data, error } = useData<{ devices: DeviceRow[] }>(() => sharedCall<{ devices: DeviceRow[] }>("mdm/devices", {}, 15_000), [], 30_000);
	if (!data) return <Loading error={error} />;
	const rows = [...data.devices].sort((a, b) => a.score - b.score);
	return (
		<div style={{ display: "grid", gap: 8, fontSize: 13 }}>
			<List
				empty="No device is enrolled yet (docs/MDM.md)."
				items={rows.map((d) => (
					<span key={d.udid}>
						<Pill value={d.status === "enrolled" ? (d.score >= 70 ? "healthy" : d.score > 0 ? "attention" : "blocked") : "left management"} /> <Mono>{d.assetTag}</Mono> score {d.score} · {d.productName ?? "?"} {d.osVersion ?? ""} · seen {when(d.lastSeenAt)}
						{d.openIncidents > 0 && (
							<>
								{" "}
								· <a href={contentUrl("incidents")}>{d.openIncidents} open incident(s)</a>
							</>
						)}
						{!d.push && <Muted> · no push token</Muted>}
					</span>
				))}
			/>
			<Muted>
				Profiles: <a href={contentUrl("mdm_profiles")}>Device profiles</a> · Incidents: <a href={contentUrl("incidents")}>Incidents</a>
			</Muted>
		</div>
	);
}

export const widgets = {
	devices: DevicesWidget,
	entities: EntitiesWidget,
	work: WorkWidget,
	mission: MissionWidget,
	physical: PhysicalWidget,
	attention: AttentionWidget,
	approvals: ApprovalsWidget,
	bridge: BridgeWidget,
	evidence: EvidenceWidget,
	events: EventsWidget,
};
