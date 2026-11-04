import type { PluginAdminExports } from "emdash";

// Powerfarm's colours for the whole EmDash admin, not only these pages (theme.css).
import "./theme.css";
import { contentListColumns } from "./columns.js";
import { GraphPage } from "./GraphPage.js";
import { AuditPage, EngineeringPage } from "./OtherPages.js";
import { fields } from "./fields.js";
import { contentEditorPanels } from "./panels.js";
import { RecoveryPage } from "./RecoveryPage.js";
import { widgets as widgetComponents } from "./widgets.js";

export const pages: PluginAdminExports["pages"] = {
	"/recovery": RecoveryPage,
	"/graph": GraphPage,
	"/engineering": EngineeringPage,
	"/audit": AuditPage,
} as unknown as PluginAdminExports["pages"];

export const widgets: PluginAdminExports["widgets"] = widgetComponents as unknown as PluginAdminExports["widgets"];

// Discovered by the EmDash admin from this module (see EmDash docs: React admin extensions).
export { contentEditorPanels, contentListColumns, fields };
