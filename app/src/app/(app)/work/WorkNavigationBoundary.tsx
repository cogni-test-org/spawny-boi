// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";

import type { VisibilityState } from "@tanstack/react-table";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import {
	createContext,
	type ReactNode,
	useContext,
	useRef,
	useState,
	useTransition,
} from "react";

export type WorkIntent = {
	params: URLSearchParams;
	itemId: string | undefined;
	method: "push" | "replace";
	resetHistory?: boolean;
};

function useOwner(search: string, itemId: string | undefined) {
	const [desired, setDesired] = useState<WorkIntent>(() => ({
		params: new URLSearchParams(search),
		itemId,
		method: "replace",
	}));
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
	const [history, setHistory] = useState<string[]>([]);
	const [isNavigating, startNavigation] = useTransition();
	const [settledOperation, setSettledOperation] = useState(0);
	const [navigationLocked, setNavigationLocked] = useState(false);
	const navigation = useRef<{
		desired: WorkIntent;
		committed: {
			href: string;
			key: string;
			cursor: string;
			stack: string[];
		} | null;
		sequence: number;
		flight: {
			id: number;
			to: string;
			stack: string[] | undefined;
			failed: boolean;
			committed: boolean;
		} | null;
	}>({ desired, committed: null, sequence: 0, flight: null });
	return {
		desired,
		setDesired,
		columnVisibility,
		setColumnVisibility,
		history,
		setHistory,
		isNavigating,
		startNavigation,
		settledOperation,
		setSettledOperation,
		navigationLocked,
		setNavigationLocked,
		navigation,
	};
}

const Context = createContext<ReturnType<typeof useOwner> | null>(null);

function Provider({
	children,
	search,
	itemId,
}: {
	children: ReactNode;
	search: string;
	itemId: string | undefined;
}) {
	const owner = useOwner(search, itemId);
	return <Context.Provider value={owner}>{children}</Context.Provider>;
}

export function WorkNavigationBoundary({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	const params = useParams();
	const search = useSearchParams();
	const itemId = typeof params.id === "string" ? params.id : undefined;
	const supported =
		pathname === "/work" ||
		(itemId !== undefined && /^\/work\/items\/[^/]+$/.test(pathname));
	return supported ? (
		<Provider
			search={search.toString()}
			itemId={pathname === "/work" ? undefined : itemId}
		>
			{children}
		</Provider>
	) : (
		children
	);
}

export function useWorkNavigation() {
	const owner = useContext(Context);
	if (!owner) throw new Error("Work navigation requires its layout boundary");
	return owner;
}
