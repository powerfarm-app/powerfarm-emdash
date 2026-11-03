/** Contextual panels in the EmDash content editor sidebar. */
import * as React from "react";

import { type ControlRow, contentUrl, type EntityPanelData, type FleetAsset, type JobSummary, pluginPage, type PreviewResult, type RegistrationOptions, sharedCall } from "./api.js";
import { KV, List, Loading, Mono, Muted, Pill, useData, when } from "./ui.js";

interface PanelProps {
	collection: string;
	entry: { id: string; translationGroup: string | null; data: Record<string, unknown> };
	locale?: string;
}

function AssetPanel({ entry }: PanelProps) {
	const tag = String(entry.data.asset_tag ?? "");
	const { data, error } = useData(
		() =>
			sharedCall<FleetAsset & { asset: Record<string, unknown>; operations: Array<{ id: string; opCode: string; status: string; operation: string }>; evidence: Array<{ id: string; type: string; attests: string | null; createdAt: string; digestVerified: boolean }> }>(
				"panel/asset",
				{ id: tag },
				5_000,
			),
		[tag],
	);
	if (!tag) return <Muted>Save the asset with an asset tag first.</Muted>;
	if (!data) return <Loading error={error} />;
	return (
		<div style={{ display: "grid", gap: 10, fontSize: 13 }}>
			<div>
				<Pill value={data.status} /> {data.reasons[0] && <Muted>{data.reasons[0]}</Muted>}
			</div>
			<KV
				rows={[
					["Device class", data.deviceClass],
					["Mission", data.inMission ? "M001" : data.role === "comms_terminal" ? "Communications terminal" : "Not in scope"],
					["Serial", <Mono key="s">{String(data.asset.serial_number ?? "not recorded")}</Mono>],
					["ECID", <Mono key="e">{String(data.asset.ecid ?? "not recorded")}</Mono>],
					["Last verified", when(data.lastVerifiedAt)],
				]}
			/>
			<div>
				<strong>Next</strong>: {data.next.action} {data.next.procedureCode && <Mono>{data.next.procedureCode}</Mono>}
				{data.next.blocking && <div style={{ color: "#9a6700" }}>{data.next.blocking}</div>}
				<List empty="" items={data.next.instructions.map((s) => s)} />
			</div>
			<div>
				<strong>Missing</strong>
				<List empty="Nothing." items={data.missing} />
			</div>
			<div>
				<strong>Operations</strong>
				<List
					empty="None yet."
					items={data.operations.slice(0, 8).map((o) => (
						<span key={o.id}>
							<a href={contentUrl("recovery_operations", o.id)}>{o.opCode}</a> {o.operation} <Pill value={o.status} />
						</span>
					))}
				/>
			</div>
			<div>
				<strong>Evidence</strong>
				<List
					empty="None yet."
					items={data.evidence.slice(0, 8).map((e) => (
						<span key={e.id}>
							<a href={contentUrl("evidence", e.id)}>{e.attests ?? e.type}</a> <Muted>{when(e.createdAt)}</Muted> {e.digestVerified ? "✓" : ""}
						</span>
					))}
				/>
			</div>
			<a href={pluginPage("/graph", { node: `asset:${entry.translationGroup ?? entry.id}` })}>Open in Graph →</a>
		</div>
	);
}

interface OperationData {
	opCode: string | null;
	status: string;
	pendingDraft: boolean;
	liveRevision: string | null;
	draftRevision: string | null;
	approval: { approvedBy: string | null; approvedAt: string | null } | null;
	preparedByAi: boolean;
	target: { assetTag: string; deviceClass: string | null; inMission: boolean } | null;
	procedure: { code: string | null; title: string } | null;
	operation: string;
	adapter: string | null;
	operationClass: string | null;
	destructive: boolean;
	dryRun: boolean;
	dataDecision: string | null;
	safeguards: string[];
	requiredEvidence: string[];
	blockers: string[];
	jobs: JobSummary[];
	evidence: Array<{ id: string; type: string; attests: string | null; digestVerified: boolean; sha256: string | null; createdAt: string }>;
}

function OperationPanel({ entry }: PanelProps) {
	const { data, error } = useData(() => sharedCall<OperationData>("panel/operation", { id: entry.id, includeDrafts: true }, 3_000), [entry.id]);
	if (!data) return <Loading error={error} />;
	return (
		<div style={{ display: "grid", gap: 10, fontSize: 13 }}>
			<div>
				{data.status === "published" ? <Pill value="approved" /> : <Pill value="draft" />} {data.pendingDraft && <Pill value="proposed" />}
				{data.preparedByAi && <Muted> Prepared by an AI client — review carefully.</Muted>}
			</div>
			<KV
				rows={[
					["Approved revision", <Mono key="r">{data.liveRevision ?? "not approved"}</Mono>],
					["Approved by", data.approval?.approvedBy ?? "—"],
					["Target", data.target ? `${data.target.assetTag} (${data.target.deviceClass ?? "?"})` : "—"],
					["Procedure", data.procedure?.code ?? "—"],
					["Adapter", data.adapter ?? "—"],
					["Class", data.operationClass ?? "—"],
					["Destructive", data.destructive ? "yes" : data.dryRun ? "no (dry run)" : "no"],
					["Data decision", data.dataDecision ?? "—"],
				]}
			/>
			<div>
				<strong>Safeguards</strong>
				<List empty="—" items={data.safeguards} />
			</div>
			<div>
				<strong>{data.status === "published" ? "Rules now" : "What blocks approval"}</strong>
				<List empty="Nothing: publishing will approve it." items={data.blockers} />
			</div>
			<div>
				<strong>Jobs</strong>
				<List
					empty="No job yet."
					items={data.jobs.map((j) => (
						<span key={j.id}>
							<Pill value={j.status} /> {j.executionMode && j.executionMode !== "real" ? <Pill value={j.executionMode} /> : null} rev <Mono>{j.opRevision.slice(-8)}</Mono>
							{j.claimedBy && <Muted> by {j.claimedBy}</Muted>}
							{j.missingEvidence.length > 0 && <div style={{ color: "#9a6700" }}>Missing evidence: {j.missingEvidence.join(", ")}</div>}
							{j.status === "needs_inspection" && !j.inspection && (
								<div>
									<a href={pluginPage("/recovery", { job: j.id })}>Resolve inspection →</a>
								</div>
							)}
						</span>
					))}
				/>
			</div>
			<div>
				<strong>Evidence</strong> <Muted>(required: {data.requiredEvidence.join(", ") || "—"})</Muted>
				<List
					empty="None recorded."
					items={data.evidence.map((e) => (
						<span key={e.id}>
							<a href={contentUrl("evidence", e.id)}>{e.attests ?? e.type}</a> {e.digestVerified ? "✓ digest verified" : ""} <Muted>{when(e.createdAt)}</Muted>
						</span>
					))}
				/>
			</div>
		</div>
	);
}

interface ProcedureData {
	code: string;
	operation: string;
	deviceClasses: string[];
	adapter: string;
	destructive: boolean;
	validatedOn: string[];
	adapterReady: boolean;
	preconditions: string | null;
	requiredTools: string | null;
	physicalSteps: string | null;
	expectedResults: string | null;
	requiredEvidence: string[];
	failureInstructions: string | null;
}

function ProcedurePanel({ entry }: PanelProps) {
	const code = String(entry.data.code ?? entry.id);
	const { data, error } = useData(() => sharedCall<ProcedureData>("panel/procedure", { id: code }, 10_000), [code]);
	if (!data) return <Loading error={error} />;
	return (
		<div style={{ display: "grid", gap: 10, fontSize: 13 }}>
			<KV
				rows={[
					["Operation", <Mono key="o">{data.operation}</Mono>],
					["Devices", data.deviceClasses.join(", ") || "—"],
					["Adapter", data.adapter],
					["Ready", data.adapter === "bridge" ? (data.adapterReady ? `validated on ${data.validatedOn.join(", ")}` : "not validated on any bridge") : data.adapter === "manual" ? "manual procedure" : "guidance only"],
					["Destructive", data.destructive ? "yes" : "no"],
					["Required evidence", data.requiredEvidence.join(", ") || "—"],
				]}
			/>
			{[
				["Preconditions", data.preconditions],
				["Tools", data.requiredTools],
				["Operator actions", data.physicalSteps],
				["Expected results", data.expectedResults],
				["If it fails", data.failureInstructions],
			].map(([k, v]) =>
				v ? (
					<div key={k as string}>
						<strong>{k}</strong>
						<div style={{ whiteSpace: "pre-wrap" }}>{v}</div>
					</div>
				) : null,
			)}
		</div>
	);
}

interface EvidenceData {
	type: string;
	attests: string | null;
	assetTag: string | null;
	opCode: string | null;
	jobId: string | null;
	opRevision: string | null;
	originalFilename: string | null;
	mediaId: string | null;
	sha256: string | null;
	sizeBytes: number | null;
	mimeType: string | null;
	createdAt: string | null;
	digestStatus: string;
	executionMode: string | null;
	signedBy: string | null;
	provenance: Array<{ eventId: string; type: string; at: string; actor: string; hash: string }>;
}

function EvidencePanel({ entry }: PanelProps) {
	const { data, error } = useData(() => sharedCall<EvidenceData>("panel/evidence", { id: entry.translationGroup ?? entry.id }, 10_000), [entry.id]);
	if (!data) return <Loading error={error} />;
	return (
		<div style={{ display: "grid", gap: 10, fontSize: 13 }}>
			<div>
				<Pill value={data.digestStatus} /> {data.executionMode && data.executionMode !== "real" ? <Pill value={data.executionMode} /> : null}
			</div>
			<KV
				rows={[
					["Asset", data.assetTag],
					["Operation", data.opCode],
					["Job", data.jobId ? <Mono key="j">{data.jobId}</Mono> : "—"],
					["Approved revision", data.opRevision ? <Mono key="r">{data.opRevision}</Mono> : "—"],
					["File", data.originalFilename],
					["Media", data.mediaId ? <Mono key="m">{data.mediaId}</Mono> : "—"],
					["SHA-256", data.sha256 ? <Mono key="h">{data.sha256}</Mono> : "—"],
					["Size", data.sizeBytes ? `${data.sizeBytes} bytes` : "—"],
					["Recorded", when(data.createdAt)],
					["Signed by", data.signedBy],
				]}
			/>
			<div>
				<strong>Provenance</strong>
				<List
					empty="Recorded in the editor."
					items={data.provenance.map((p) => (
						<span key={p.eventId}>
							{when(p.at)} <Mono>{p.type}</Mono> by {p.actor} <Muted>hash {p.hash.slice(0, 12)}…</Muted>
						</span>
					))}
				/>
			</div>
		</div>
	);
}

function Controls({ title, rows }: { title: string; rows: ControlRow[] }) {
	if (rows.length === 0) return null;
	return (
		<div>
			<strong>{title}</strong>
			<List
				empty=""
				items={rows.map((r) => (
					<span key={r.control}>
						<Pill value={r.status} /> {r.label} <Muted>{r.detail}</Muted>
					</span>
				))}
			/>
		</div>
	);
}

interface Duplicates {
	ok: boolean;
	problems: string[];
	duplicates: Array<{ reason: string; subject: string; title: string | null; adminUrl: string | null }>;
}

/** What publishing will start: a simulation of each active registration blueprint (writes nothing). */
function WillStart({ collection, code }: { collection: string; code: string }) {
	const { data } = useData(async () => {
		const options = await sharedCall<RegistrationOptions>("entities/options", {}, 60_000);
		const bps = options.blueprints.filter((b) => b.published && b.target === collection && b.trigger === "registered" && b.code);
		return Promise.all(bps.map((b) => sharedCall<PreviewResult>("automation/preview", { blueprint: b.code, collection, subject: code }, 10_000).catch(() => null)));
	}, [collection, code]);
	const previews = (data ?? []).filter((p): p is PreviewResult => !!p);
	if (previews.length === 0) return null;
	return (
		<details>
			<summary>Publishing will start {previews.map((p) => p.blueprint).join(", ")}</summary>
			{previews.map((p) => (
				<List
					key={p.blueprint}
					empty=""
					items={p.steps.map((st) => (
						<span key={st.id}>
							<Pill value={st.outcome} /> {st.detail}
						</span>
					))}
				/>
			))}
			<Muted>Simulation: nothing was written.</Muted>
		</details>
	);
}

/** Identity, duplicates, controls, onboarding and history for 1.2 entities. */
function EntityPanel({ collection, entry }: PanelProps) {
	const ref = entry.translationGroup ?? entry.id;
	const { data, error } = useData(() => sharedCall<EntityPanelData>("entities/panel", { collection, ref, includeDrafts: true }, 5_000), [collection, ref]);
	const title = String(entry.data.title ?? "");
	const { data: dups } = useData(
		() => (data ? sharedCall<Duplicates>("entities/check", { collection, title: title || data.title, identifiers: Array.isArray(entry.data.identifiers) ? entry.data.identifiers : [], subject: data.subject }, 10_000) : Promise.resolve(null)),
		[collection, title, JSON.stringify(entry.data.identifiers ?? []), data?.subject],
	);
	if (!data) return error && /Not found/.test(error) ? <Muted>Save the record first. Confidential and restricted records are shown only to people who may see them.</Muted> : <Loading error={error} />;
	const active = data.lifecycle === "active";
	return (
		<div style={{ display: "grid", gap: 10, fontSize: 13 }}>
			<div>
				<Pill value={data.status === "published" ? (data.lifecycle ?? "intake") : "draft"} /> <Pill value={data.classification} /> <Mono>{data.subject}</Mono>
				{data.mergedInto && <div style={{ color: "#9a6700" }}>Merged into {data.mergedInto}.</div>}
			</div>
			{dups && dups.duplicates.length > 0 && (
				<div style={{ color: "#b42318" }}>
					<strong>Possible duplicates</strong>
					<List
						empty=""
						items={dups.duplicates.map((d) => (
							<span key={d.subject + d.reason}>
								{d.reason}: {d.adminUrl ? <a href={d.adminUrl}>{d.subject}</a> : <Mono>{d.subject}</Mono>}
							</span>
						))}
					/>
				</div>
			)}
			<div>
				<strong>Identity</strong>
				<List
					empty="No identifiers."
					items={data.identifiers.map((i) => (
						<span key={i.identifier}>
							<Mono>{i.identifier}</Mono> <Pill value={i.status} /> {i.holder && <Muted>held by {i.holder}</Muted>}
						</span>
					))}
				/>
			</div>
			{data.status !== "published" && <WillStart collection={collection} code={data.subject.split(":")[1] ?? ""} />}
			{active ? <Controls title="Operation" rows={data.controls.operation} /> : <Controls title="To activate" rows={data.controls.activation} />}
			<details>
				<summary>Retirement</summary>
				<Controls title="To retire" rows={data.controls.retirement} />
			</details>
			{data.controls.expiredExceptions.length > 0 && <div style={{ color: "#b42318" }}>Expired exceptions: {data.controls.expiredExceptions.join(", ")}</div>}
			<div>
				<strong>Open work</strong>
				<List
					empty="None."
					items={data.workItems
						.filter((w) => w.status === "open")
						.map((w) => (
							<span key={w.id}>
								<a href={w.adminUrl}>{w.code}</a> {w.title} <Muted>{w.kind}{w.requiredRole ? ` · ${Number(w.requiredRole) >= 50 ? "administrator" : "editor"}` : ""}</Muted>
							</span>
						))}
				/>
			</div>
			<div>
				<strong>Onboarding</strong>
				<List
					empty="No blueprint has run for this record."
					items={data.runs.map((r) => (
						<details key={r.id}>
							<summary>
								<Mono>{r.blueprint}</Mono> <Pill value={r.status} /> <Muted>revision {r.templateRevision}</Muted>
							</summary>
							<List
								empty=""
								items={r.steps.map((st) => (
									<span key={st.id}>
										<Mono>{st.id}</Mono> <Pill value={st.status} /> {st.ref && <a href={contentUrl(st.ref.collection, st.ref.id)}>{st.ref.key ?? "open"}</a>} {st.message && <Muted>{st.message}</Muted>}
									</span>
								))}
							/>
						</details>
					))}
				/>
			</div>
			<Muted>
				{data.revisions.length} revision(s) in this record's history; who changed what is in the audit log. Controls are met by Evidence attestations with subject <Mono>{data.subject}</Mono>, or waived by an approved Security exception.
			</Muted>
		</div>
	);
}

export const contentEditorPanels = [
	{ id: "asset-recovery", title: "Powerfarm · Recovery", component: AssetPanel, collections: ["assets"], order: 10 },
	{ id: "operation-approval", title: "Powerfarm · Approval and execution", component: OperationPanel, collections: ["recovery_operations"], order: 10, minRole: 40 },
	{ id: "procedure-execution", title: "Powerfarm · Execution", component: ProcedurePanel, collections: ["procedures"], order: 10 },
	{ id: "evidence-integrity", title: "Powerfarm · Integrity", component: EvidencePanel, collections: ["evidence"], order: 10, minRole: 40 },
	{ id: "entity-controls", title: "Powerfarm · Identity, controls and onboarding", component: EntityPanel, collections: ["clients", "products", "services", "service_instances", "contracts"], order: 10, minRole: 20 },
];
