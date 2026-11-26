/**
 * Auto-Commit on Exit Extension
 *
 * Commits uncommitted changes when Pi exits, so work is never lost.
 * The commit subject is derived from the last assistant message.
 *
 * Safety defaults:
 *  - Only a real exit (`reason === "quit"`) commits by default. Session
 *    replacement flows (/new, /resume, /fork, /reload) are skipped — add them
 *    to COMMIT_REASONS below if you want those committed too.
 *  - Skips protected branches (main / master) by default so half-finished work
 *    never silently lands on the primary branch. Clear PROTECTED_BRANCHES to disable.
 *  - Skips when git user.name/user.email are unset, when the repo has no changes,
 *    or when nothing remains staged after pathspec exclusions.
 *  - Uses native Git exclude pathspecs (`git add -A -- ':!...'`) aligned with
 *    security-guard.ts so secrets and credentials are never staged (works even
 *    on unborn branches with no initial commit).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Session-shutdown reasons that trigger a commit.
// Valid reasons: "quit" | "reload" | "new" | "resume" | "fork"
const COMMIT_REASONS = new Set(["quit"]);

// Branches where silent auto-commit is skipped by default.
const PROTECTED_BRANCHES = new Set(["main", "master"]);

// Native Git exclude pathspecs (aligned with security-guard.ts).
// Matched anywhere in the repository tree via :(exclude,glob) / :!...
const EXCLUDE_PATHSPECS = [
	":(exclude,glob)**/.env",
	":(exclude,glob)**/.env.*",
	":(exclude,glob)**/*.pem",
	":(exclude,glob)**/*.key",
	":(exclude,glob)**/*.p12",
	":(exclude,glob)**/*.pfx",
	":(exclude,glob)**/*.keystore",
	":(exclude,glob)**/*.jks",
	":(exclude,glob)**/id_rsa*",
	":(exclude,glob)**/id_ed25519*",
	":(exclude,glob)**/*secret*",
	":(exclude,glob)**/*credential*",
	":(exclude,glob)**/.npmrc",
	":(exclude,glob)**/.pnpmrc",
	":(exclude,glob)**/.netrc",
	":(exclude,glob)**/_netrc",
	":(exclude,glob)**/auth/*.info",
];

function cleanSubject(text: string): string {
	const line = text
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	if (!line) return "chore: auto-commit";

	const cleaned = line
		.replace(/^#{1,6}\s+/, "") // heading marker
		.replace(/^[-*+]\s+/, "") // list marker
		.replace(/^>+\s*/, "") // blockquote marker
		.replace(/\*\*/g, "")
		.replace(/`/g, "")
		.trim();
	if (!cleaned) return "chore: auto-commit";

	return cleaned.length > 72 ? `${cleaned.slice(0, 72)}...` : cleaned;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async (event, ctx) => {
		if (!COMMIT_REASONS.has(event.reason)) return;

		// Not a git repo?
		const { code: repoCode } = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
		if (repoCode !== 0) return;

		// Protect primary branches from silent auto-commits.
		if (PROTECTED_BRANCHES.size > 0) {
			const { stdout: branchOut, code: branchCode } = await pi.exec("git", [
				"symbolic-ref",
				"--short",
				"HEAD",
			]);
			const branch = branchCode === 0 ? branchOut.trim() : "";
			if (branch && PROTECTED_BRANCHES.has(branch)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Skipped auto-commit on protected branch (${branch})`, "info");
				}
				return;
			}
		}

		// Nothing to commit?
		const { stdout: status } = await pi.exec("git", ["status", "--porcelain"]);
		if (!status.trim()) return;

		// git identity is required or `git commit` fails.
		const [name, email] = await Promise.all([
			pi.exec("git", ["config", "user.name"]),
			pi.exec("git", ["config", "user.email"]),
		]);
		if (!name.stdout.trim() || !email.stdout.trim()) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Skipped auto-commit: git user.name/user.email not configured",
					"warning",
				);
			}
			return;
		}

		// Last assistant text becomes the commit subject.
		let subject = "";
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				const content = entry.message.content;
				if (Array.isArray(content)) {
					subject = content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				}
				break;
			}
		}
		const message = subject ? `[pi] ${cleanSubject(subject)}` : "[pi] chore: auto-commit";

		// Stage everything except excluded sensitive paths in a single command.
		const { code: addCode } = await pi.exec("git", ["add", "-A", "--", ".", ...EXCLUDE_PATHSPECS]);
		if (addCode !== 0) {
			if (ctx.hasUI) {
				ctx.ui.notify("Auto-commit skipped: git add failed", "warning");
			}
			return;
		}

		// Verify something is actually staged (e.g. if only excluded files changed).
		const { code: diffCode } = await pi.exec("git", ["diff", "--cached", "--quiet"]);
		if (diffCode === 0) return;

		const { code: commitCode } = await pi.exec("git", ["commit", "-m", message]);
		if (ctx.hasUI) {
			if (commitCode === 0) {
				ctx.ui.notify(`Auto-committed: ${message}`, "info");
			} else {
				ctx.ui.notify("Auto-commit failed — check git output", "warning");
			}
		}
	});
}
