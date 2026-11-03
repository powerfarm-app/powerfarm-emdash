/** Read-only columns on EmDash's collection lists, one batched request per visible page. */
import * as React from "react";

import { sharedCall } from "./api.js";
import { Pill } from "./ui.js";

interface CellProps {
	collection: string;
	item: { id: string };
	visibleItems: ReadonlyArray<{ id: string }>;
}

function useCells(collection: string, visibleItems: ReadonlyArray<{ id: string }>) {
	const ids = visibleItems.map((i) => i.id);
	const [cells, setCells] = React.useState<Record<string, Record<string, unknown>>>();
	const key = ids.join(",");
	React.useEffect(() => {
		let live = true;
		sharedCall<Record<string, Record<string, unknown>>>("columns", { collection, ids }, 10_000)
			.then((c) => live && setCells(c))
			.catch(() => live && setCells({}));
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [collection, key]);
	return cells;
}

function cellOf(field: string, render: (v: unknown) => React.ReactNode = (v) => (v === null || v === undefined || v === "" ? "—" : String(v))) {
	return function Cell({ collection, item, visibleItems }: CellProps) {
		const cells = useCells(collection, visibleItems);
		if (!cells) return <span style={{ opacity: 0.5 }}>…</span>;
		return <>{render(cells[item.id]?.[field])}</>;
	};
}

function useEntityCells(collection: string, visibleItems: ReadonlyArray<{ id: string }>) {
	const ids = visibleItems.map((i) => i.id);
	const [cells, setCells] = React.useState<Record<string, Record<string, unknown>>>();
	const key = ids.join(",");
	React.useEffect(() => {
		let live = true;
		sharedCall<Record<string, Record<string, unknown>>>("entities/columns", { collection, ids }, 10_000)
			.then((c) => live && setCells(c))
			.catch(() => live && setCells({}));
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [collection, key]);
	return cells;
}

function entityCell(field: string) {
	return function Cell({ collection, item, visibleItems }: CellProps) {
		const cells = useEntityCells(collection, visibleItems);
		if (!cells) return <span style={{ opacity: 0.5 }}>…</span>;
		const v = cells[item.id]?.[field];
		return <Pill value={v ? String(v) : null} />;
	};
}

const ENTITIES = ["clients", "products", "services", "service_instances", "contracts"];

const pill = (v: unknown) => <Pill value={v ? String(v) : null} />;
const date = (v: unknown) => (typeof v === "string" && v ? new Date(v).toLocaleDateString() : "—");
const count = (v: unknown) => (typeof v === "number" ? (v === 0 ? "none" : `${v} item${v === 1 ? "" : "s"}`) : "—");

export const contentListColumns = [
	{ id: "asset-mission", label: "Mission", cell: cellOf("mission"), collections: ["assets"], order: 10 },
	{ id: "asset-readiness", label: "Status", cell: cellOf("readiness", pill), collections: ["assets"], order: 11 },
	{ id: "asset-verified", label: "Last verified", cell: cellOf("lastVerified", date), collections: ["assets"], order: 12, minRole: 40 },
	{ id: "asset-missing", label: "Missing", cell: cellOf("missing", count), collections: ["assets"], order: 13, minRole: 40 },
	{ id: "asset-blocker", label: "Blocker", cell: cellOf("blocker"), collections: ["assets"], order: 14, minRole: 40 },
	{ id: "op-target", label: "Target", cell: cellOf("target"), collections: ["recovery_operations"], order: 10 },
	{ id: "op-class", label: "Class", cell: cellOf("class"), collections: ["recovery_operations"], order: 11 },
	{ id: "op-risk", label: "Risk", cell: cellOf("risk", pill), collections: ["recovery_operations"], order: 12 },
	{ id: "op-approval", label: "Approval", cell: cellOf("approval", pill), collections: ["recovery_operations"], order: 13 },
	{ id: "op-job", label: "Job", cell: cellOf("job"), collections: ["recovery_operations"], order: 14 },
	{ id: "op-evidence", label: "Evidence", cell: cellOf("evidence"), collections: ["recovery_operations"], order: 15 },
	{ id: "proc-devices", label: "Devices", cell: cellOf("devices"), collections: ["procedures"], order: 10 },
	{ id: "proc-adapter", label: "Adapter", cell: cellOf("adapter"), collections: ["procedures"], order: 11 },
	{ id: "proc-verification", label: "Evidence required", cell: cellOf("verification"), collections: ["procedures"], order: 12 },
	// Lifecycle and classification are native list columns (seed admin.listColumns); only derived state is added here.
	{ id: "entity-readiness", label: "Controls", cell: entityCell("readiness"), collections: ENTITIES, order: 12 },
];
