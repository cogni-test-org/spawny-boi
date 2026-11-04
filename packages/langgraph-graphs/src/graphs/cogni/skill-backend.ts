// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Metadata-only discovery, followed by a host-authorized exact-ID body read. */
import type { BackendProtocolV2, ReadRawResult, ReadResult } from "deepagents";

export class HubSkillBackend implements BackendProtocolV2 {
	private readonly ids: Set<string>;
	constructor(
		ids: readonly string[],
		private readonly readBody: (id: string) => Promise<string>,
		private readonly onReadFailure: () => void = () => {},
	) {
		this.ids = new Set(
			ids.filter((id) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)),
		);
	}
	ls(path: string) {
		if (path !== "/") return { error: "unsupported_skill_listing" };
		return {
			files: [...this.ids]
				.sort()
				.map((id) => ({ path: `/${id}/`, is_dir: true })),
		};
	}
	private async body(path: string) {
		const match = /^\/([a-z0-9][a-z0-9-]{0,63})\/SKILL\.md$/.exec(path);
		if (!match || !this.ids.has(match[1] ?? ""))
			throw new Error("invalid_skill_path");
		const id = match[1] ?? "";
		const body = await this.readBody(id);
		if (!body.trim()) throw new Error("skill_body_empty");
		const content = `---\nname: ${id}\ndescription: Node guidance ${id}\n---\n\n${body}`;
		if (new TextEncoder().encode(content).length > 65_536)
			throw new Error("skill_body_exceeds_limit");
		return content;
	}
	async read(path: string, offset = 0, limit = 500): Promise<ReadResult> {
		try {
			if (offset !== 0) {
				this.onReadFailure();
				return { error: "skill_requires_complete_read" };
			}
			const body = await this.body(path);
			const lines = body.split("\n");
			if (lines.length > limit) {
				this.onReadFailure();
				return { error: "skill_requires_complete_read" };
			}
			return {
				content: body,
				mimeType: "text/markdown",
				totalLines: lines.length,
				startLine: 1,
				endLine: lines.length,
			};
		} catch (error) {
			this.onReadFailure();
			return {
				error: error instanceof Error ? error.message : "skill_read_failed",
			};
		}
	}
	async readRaw(path: string): Promise<ReadRawResult> {
		try {
			const content = await this.body(path);
			const now = new Date().toISOString();
			return {
				data: {
					content,
					mimeType: "text/markdown",
					created_at: now,
					modified_at: now,
				},
			};
		} catch (error) {
			this.onReadFailure();
			return {
				error: error instanceof Error ? error.message : "skill_read_failed",
			};
		}
	}
	write() {
		return { error: "skills_read_only" };
	}
	edit() {
		return { error: "skills_read_only" };
	}
	delete() {
		return { error: "skills_read_only" };
	}
	grep() {
		return { error: "skill_search_unsupported" };
	}
	glob() {
		return { error: "skill_glob_unsupported" };
	}
}
