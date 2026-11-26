/**
 * Git Checkpoint Extension
 *
 * Snapshots uncommitted tracked working-tree changes at the start of every turn
 * so /fork (or /clone) can restore the code to that point in history.
 *
 * How it works:
 *  - `turn_start`: capture tracked changes with `git stash create` (creates a
 *    commit object without touching the stash list or working tree) and key it
 *    to the current leaf entry id. Note: untracked files are not included by
 *    `git stash create`.
 *  - `session_before_fork`: if a checkpoint exists for the selected entry,
 *    first snapshot the current dirty state as a safety backup, then offer to
 *    apply the checkpoint via `git stash apply`.
 *  - `session_shutdown`: drop the in-memory map and repo cache. Unapplied stash
 *    commits are unreachable and get reclaimed by `git gc` automatically.
 *
 * Best-effort by design: git errors never block Pi. Snapshots live in memory
 * only, so they are lost across /reload or restart.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// fork entry id -> stash commit hash
	const checkpoints = new Map<string, string>();
	// Cache repo detection per session so we don't spawn a subprocess every turn.
	let isGitRepo: boolean | null = null;

	async function inGitRepo(): Promise<boolean> {
		if (isGitRepo !== null) return isGitRepo;
		const { code } = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
		isGitRepo = code === 0;
		return isGitRepo;
	}

	pi.on("turn_start", async (_event, ctx) => {
		if (!(await inGitRepo())) return;

		const entryId = ctx.sessionManager.getLeafId();
		if (!entryId) return;

		// Only snapshot when there are tracked changes to restore.
		const { stdout, code } = await pi.exec("git", ["stash", "create"]);
		if (code !== 0 || !stdout.trim()) return;

		checkpoints.set(entryId, stdout.trim());
	});

	pi.on("session_before_fork", async (event, ctx) => {
		if (!(await inGitRepo())) return;

		const ref = checkpoints.get(event.entryId);
		if (!ref) return;

		// Never mutate the working tree without a user to confirm.
		if (!ctx.hasUI) return;

		const choice = await ctx.ui.select(
			`Restore tracked changes to fork point? (checkpoint ${ref.slice(0, 7)})`,
			["Yes, apply checkpoint", "No, keep current files"],
		);
		if (choice !== "Yes, apply checkpoint") return;

		// Take a best-effort safety backup of current dirty work before applying.
		const { stdout: backupOut, code: backupCode } = await pi.exec("git", ["stash", "create"]);
		const backupRef = backupCode === 0 ? backupOut.trim() : "";

		const { code } = await pi.exec("git", ["stash", "apply", ref]);
		if (code === 0) {
			checkpoints.delete(event.entryId);
			const note = backupRef
				? `Checkpoint ${ref.slice(0, 7)} applied (previous state backup: ${backupRef.slice(0, 7)})`
				: `Checkpoint ${ref.slice(0, 7)} applied`;
			ctx.ui.notify(note, "info");
		} else {
			// Keep checkpoint ref in map on failure so user can still reference it.
			const backupHint = backupRef ? ` Pre-restore backup: ${backupRef.slice(0, 7)}.` : "";
			ctx.ui.notify(
				`Could not apply checkpoint ${ref.slice(0, 7)} (local changes conflict).${backupHint}`,
				"warning",
			);
		}
	});

	pi.on("session_shutdown", () => {
		checkpoints.clear();
		isGitRepo = null;
	});
}
