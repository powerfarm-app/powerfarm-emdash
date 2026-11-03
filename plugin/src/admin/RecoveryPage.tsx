/** Recovery workspace: fleet status, open jobs, and the person-only job actions. */
import { Button } from "@cloudflare/kumo";
import * as React from "react";

import { call, contentUrl, type Fleet, invalidateShared, type JobSummary, pluginPage } from "./api.js";
import { ErrorText, List, Loading, Mono, Muted, Pill, Table, useData, when } from "./ui.js";

function InspectionForm({ job, onDone }: { job: JobSummary; onDone: () => void }) {
	const [finding, setFinding] = React.useState("unknown");
	const [note, setNote] = React.useState("");
	const [error, setError] = React.useState<string>();
	return (
		<form
			onSubmit={async (e) => {
				e.preventDefault();
				setError(undefined);
				try {
					await call("jobs/resolve-inspection", { jobId: job.id, finding, note });
					invalidateShared();
					onDone();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			}}
			style={{ display: "grid", gap: 6, maxWidth: 520 }}
		>
			<label>
				What did you find on the device?{" "}
				<select value={finding} onChange={(e) => setFinding(e.target.value)}>
					<option value="not_executed">The operation did not run</option>
					<option value="executed">The operation completed</option>
					<option value="unknown">Unclear</option>
				</select>
			</label>
			<textarea required minLength={10} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: device shows the setup assistant in English." />
			<ErrorText error={error} />
			<div>
				<Button type="submit">Record finding</Button> <Muted>A real inventory is required before another destructive attempt.</Muted>
			</div>
		</form>
	);
}

function ManualForm({ job, onDone }: { job: JobSummary; onDone: () => void }) {
	const readOnly = /inventory|verify/.test(job.operation);
	const [outcome, setOutcome] = React.useState("succeeded");
	const [note, setNote] = React.useState("");
	const [evidence, setEvidence] = React.useState("");
	const [serial, setSerial] = React.useState("");
	const [ecid, setEcid] = React.useState("");
	const [os, setOs] = React.useState("");
	const [error, setError] = React.useState<string>();
	return (
		<form
			onSubmit={async (e) => {
				e.preventDefault();
				setError(undefined);
				try {
					await call("jobs/manual-complete", {
						jobId: job.id,
						outcome,
						note,
						evidenceIds: evidence.split(/[\s,]+/).filter(Boolean),
						observed: readOnly ? { serialNumber: serial || undefined, ecid: ecid || undefined, osVersion: os || undefined } : undefined,
					});
					invalidateShared();
					onDone();
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
				}
			}}
			style={{ display: "grid", gap: 6, maxWidth: 560 }}
		>
			<label>
				Outcome{" "}
				<select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
					<option value="succeeded">Done, as described in the procedure</option>
					<option value="failed">Failed</option>
				</select>
			</label>
			{readOnly && (
				<>
					<input placeholder="Serial number as read from the device" value={serial} onChange={(e) => setSerial(e.target.value)} />
					<input placeholder="ECID (if read in DFU mode)" value={ecid} onChange={(e) => setEcid(e.target.value)} />
					<input placeholder="OS version, e.g. 15.1" value={os} onChange={(e) => setOs(e.target.value)} />
				</>
			)}
			<input placeholder={`Evidence entry ids recorded with operation code ${job.opCode}`} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
			<textarea required minLength={5} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you did and saw." />
			<ErrorText error={error} />
			<div>
				<Button type="submit">Complete</Button> <a href={contentUrl("evidence")}>Record evidence first →</a>
			</div>
		</form>
	);
}

export function RecoveryPage() {
	const { data: fleet, error, reload } = useData(() => call<Fleet>("fleet"), [], 20_000);
	const { data: open, reload: reloadJobs } = useData(() => call<{ jobs: JobSummary[] }>("open-jobs"), [], 20_000);
	const [selected, setSelected] = React.useState<string | null>(() => new URLSearchParams(window.location.search).get("job"));
	const [actionError, setActionError] = React.useState<string>();
	const refresh = () => {
		invalidateShared();
		void reload();
		void reloadJobs();
	};

	return (
		<section style={{ display: "grid", gap: 24 }}>
			<header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
				<div>
					<h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Mission 001 — trusted recovery</h1>
					<p style={{ margin: "4px 0 0", opacity: 0.75 }}>
						{fleet ? `${fleet.trusted} of ${fleet.targets} recovery targets trusted.` : "Loading…"} Status is derived from jobs and evidence; it cannot be edited. Approve an
						operation by publishing it.
					</p>
					{fleet?.auditDegraded && (
						<p style={{ color: "#b42318", margin: "6px 0 0" }}>
							The audit journal is degraded. Destructive approvals and verification are blocked. <a href={pluginPage("/audit")}>Review</a>
						</p>
					)}
				</div>
				<div style={{ display: "flex", gap: 8 }}>
					<a href={contentUrl("recovery_operations")}>
						<Button type="button" variant="secondary">
							Recovery operations
						</Button>
					</a>
					<Button type="button" onClick={refresh}>
						Refresh
					</Button>
				</div>
			</header>

			{!fleet ? (
				<Loading error={error} />
			) : (
				<Table
					headers={["Asset", "Class", "Status", "Next action", "Missing", "Active job"]}
					rows={fleet.assets.map((a) => [
						<span key="a">
							<a href={contentUrl("assets", a.id)}>
								<strong>{a.title}</strong>
							</a>
							<div>
								<Mono>{a.assetTag}</Mono> {a.role === "comms_terminal" ? <Muted>· communications terminal</Muted> : a.role === "trusted_host" ? <Muted>· trusted host</Muted> : null}
							</div>
						</span>,
						a.deviceClass ?? "—",
						<span key="s">
							<Pill value={a.status} />
							{a.reasons[0] && <div style={{ fontSize: 12, opacity: 0.75 }}>{a.reasons[0]}</div>}
						</span>,
						<span key="n">
							{a.next.action} {a.next.procedureCode && <Mono>{a.next.procedureCode}</Mono>}
							{a.next.operator && !a.next.complete && <div style={{ fontSize: 12, color: "#0b62c4" }}>Needs a person</div>}
							{a.next.instructions.length > 0 && (
								<details>
									<summary style={{ fontSize: 12 }}>Instructions</summary>
									<List empty="" items={a.next.instructions} />
								</details>
							)}
						</span>,
						a.missing.length ? <List key="m" empty="" items={a.missing.slice(0, 4)} /> : "—",
						a.activeJobs.length ? a.activeJobs.map((j) => <div key={j.id}>{j.opCode} <Pill value={j.status} /></div>) : "—",
					])}
				/>
			)}

			<div style={{ display: "grid", gap: 12 }}>
				<h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Open jobs</h2>
				<ErrorText error={actionError} />
				{!open ? (
					<Loading />
				) : open.jobs.length === 0 ? (
					<Muted>No approved, running or unresolved jobs.</Muted>
				) : (
					<Table
						headers={["Operation", "Asset", "Status", "Mode", "Executed by", "Updated", ""]}
						rows={open.jobs.map((j) => [
							<span key="o">
								<a href={contentUrl("recovery_operations", j.opId)}>{j.opCode}</a> {j.operation}
							</span>,
							j.assetTag,
							<Pill key="s" value={j.status} />,
							<Pill key="m" value={j.executionMode ?? (j.dryRun ? "dry_run" : null)} />,
							j.adapter === "manual" ? "a person" : (j.claimedBy ?? "bridge"),
							when(j.updatedAt),
							<span key="act">
								{j.adapter === "manual" && j.status === "approved" && (
									<Button
										type="button"
										onClick={async () => {
											setActionError(undefined);
											try {
												await call("jobs/manual-start", { jobId: j.id });
												refresh();
												setSelected(j.id);
											} catch (e) {
												setActionError(e instanceof Error ? e.message : String(e));
											}
										}}
									>
										Start
									</Button>
								)}
								{(j.status === "needs_inspection" || (j.adapter === "manual" && j.status === "running")) && (
									<Button type="button" variant="secondary" onClick={() => setSelected(selected === j.id ? null : j.id)}>
										{j.status === "needs_inspection" ? "Inspect" : "Complete"}
									</Button>
								)}
							</span>,
						])}
					/>
				)}
				{open?.jobs
					.filter((j) => j.id === selected)
					.map((j) => (
						<div key={j.id} style={{ border: "1px solid rgba(127,127,127,.3)", borderRadius: 8, padding: 12 }}>
							<strong>
								{j.opCode} · {j.operation} on {j.assetTag}
							</strong>
							{j.status === "needs_inspection" ? <InspectionForm job={j} onDone={refresh} /> : <ManualForm job={j} onDone={refresh} />}
						</div>
					))}
			</div>
		</section>
	);
}
