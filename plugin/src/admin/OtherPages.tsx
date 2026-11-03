/** Engineering and Audit workspaces. */
import { Button } from "@cloudflare/kumo";
import * as React from "react";

import { call, contentUrl, type Dashboard, invalidateShared, pluginPage } from "./api.js";
import { ErrorText, List, Loading, Mono, Muted, Pill, Table, useData, when } from "./ui.js";

interface Item {
	id: string;
	key: string | null;
	title: string;
	status: string;
	data: Record<string, unknown>;
}

function Section({ title, collection, items, columns }: { title: string; collection: string; items: Item[] | undefined; columns: Array<[string, (i: Item) => React.ReactNode]> }) {
	return (
		<div style={{ display: "grid", gap: 8 }}>
			<h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
				{title} <a href={contentUrl(collection)} style={{ fontSize: 13, fontWeight: 400 }}>manage →</a>
			</h2>
			{!items ? (
				<Loading />
			) : items.length === 0 ? (
				<Muted>None published.</Muted>
			) : (
				<Table
					headers={["", ...columns.map(([h]) => h)]}
					rows={items.map((i) => [
						<a key="t" href={contentUrl(collection, i.id)}>
							{i.key ? <Mono>{i.key}</Mono> : null} {i.title}
						</a>,
						...columns.map(([, f]) => f(i)),
					])}
				/>
			)}
		</div>
	);
}

export function EngineeringPage() {
	const projects = useData(() => call<{ items: Item[] }>("engineering/projects"), []);
	const requirements = useData(() => call<{ items: Item[] }>("engineering/requirements"), []);
	const decisions = useData(() => call<{ items: Item[] }>("engineering/decisions"), []);
	const software = useData(() => call<{ items: Item[] }>("engineering/software"), []);
	const tests = useData(() => call<{ tests: Item[]; releases: Item[] }>("engineering/tests-releases"), []);
	return (
		<section style={{ display: "grid", gap: 24 }}>
			<header>
				<h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Engineering</h1>
				<p style={{ margin: "4px 0 0", opacity: 0.75 }}>Projects, requirements, decisions, software, tests and releases. All are EmDash content and part of the Graph.</p>
			</header>
			<Section title="Projects" collection="projects" items={projects.data?.items} columns={[["Status", (i) => <Pill value={String(i.data.project_status ?? "")} />]]} />
			<Section title="Requirements" collection="requirements" items={requirements.data?.items} columns={[["Priority", (i) => String(i.data.priority ?? "—")], ["Status", (i) => <Pill value={String(i.data.requirement_status ?? "")} />]]} />
			<Section title="Architecture decisions" collection="decisions" items={decisions.data?.items} columns={[["Status", (i) => <Pill value={String(i.data.decision_status ?? "")} />]]} />
			<Section title="Software and components" collection="software" items={software.data?.items} columns={[["Kind", (i) => String(i.data.software_kind ?? "—")], ["Version", (i) => String(i.data.software_version ?? "—")]]} />
			<Section title="Tests" collection="tests" items={tests.data?.tests} columns={[["Kind", (i) => String(i.data.test_kind ?? "—")], ["Last result", (i) => <Pill value={String(i.data.last_result ?? "not_run")} />], ["When", (i) => when(i.data.last_run_at as string)]]} />
			<Section title="Releases" collection="releases" items={tests.data?.releases} columns={[["EmDash", (i) => <Mono>{String(i.data.emdash_revision ?? "").slice(0, 10)}</Mono>]]} />
			<ErrorText error={projects.error ?? requirements.error ?? decisions.error ?? software.error ?? tests.error} />
		</section>
	);
}

export function AuditPage() {
	const { data, error, reload } = useData(() => call<Dashboard>("dashboard"), [], 30_000);
	const [result, setResult] = React.useState<{ cleared: boolean; problems: string[] }>();
	const [ackError, setAckError] = React.useState<string>();
	if (!data) return <Loading error={error} />;
	const a = data.audit;
	return (
		<section style={{ display: "grid", gap: 24 }}>
			<header>
				<h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Audit and health</h1>
				<p style={{ margin: "4px 0 0", opacity: 0.75 }}>The operational journal is hash-chained in EmDash plugin storage and copied into Events. EmDash's audit-log plugin records general content changes.</p>
			</header>
			<div style={{ display: "grid", gap: 6 }}>
				<div>
					Journal: <Pill value={a.degraded ? "blocked" : "verified"} /> {a.degraded && <Muted>since {when(a.since)}</Muted>}
				</div>
				<div>
					Projection backlog: {a.projectionBacklog} · jobs with audit gaps: {a.jobsWithAuditGaps}
				</div>
				{a.degraded && (
					<>
						<List empty="" items={a.reasons.slice(-10)} />
						<div>
							<Button
								type="button"
								onClick={async () => {
									setAckError(undefined);
									try {
										setResult(await call("audit/acknowledge", { confirm: true }));
										invalidateShared();
										void reload();
									} catch (e) {
										setAckError(e instanceof Error ? e.message : String(e));
									}
								}}
							>
								Verify chains and clear
							</Button>{" "}
							<Muted>Refused while any chain is broken or entries are unprojected.</Muted>
						</div>
						<ErrorText error={ackError} />
						{result && (result.cleared ? <p>Cleared.</p> : <List empty="" items={result.problems} />)}
					</>
				)}
			</div>
			<div>
				<h2 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>Scheduled tasks</h2>
				<Table
					headers={["Task", "Last run", "Result"]}
					rows={(Object.entries(data.tasks) as Array<[string, { at: string; ok: boolean; error: string | null } | null]>).map(([name, t]) => [<Mono key="n">{name}</Mono>, when(t?.at), t ? (t.ok ? <Pill value="succeeded" /> : <span style={{ color: "#b42318" }}>{t.error}</span>) : <Muted>not run yet</Muted>])}
				/>
			</div>
			<div>
				<h2 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>Bridges</h2>
				<List
					empty="No bridge has reported."
					items={data.bridges.map((b) => (
						<span key={b.id}>
							<Mono>{b.id}</Mono> <Pill value={String(b.status)} /> {String(b.version ?? "")} · last seen {when(String(b.lastSeenAt ?? ""))}
						</span>
					))}
				/>
			</div>
			<a href={pluginPage("/recovery")}>Recovery →</a>
		</section>
	);
}
