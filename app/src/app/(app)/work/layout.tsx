// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { ReactNode } from "react";
import { WorkNavigationBoundary } from "./WorkNavigationBoundary";
import { WorkRouteView } from "./WorkRouteView";

export default function WorkLayout({
	children,
}: {
	readonly children: ReactNode;
}) {
	return (
		<WorkNavigationBoundary>
			<WorkRouteView />
			{children}
		</WorkNavigationBoundary>
	);
}
