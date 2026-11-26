---
description: Run an independent read-only code review on git changes via a clean subagent
argument-hint: "[git-range-or-focus]"
---
请加载并严格遵循 `review` skill（`~/.pi/agent/skills/review/SKILL.md`）执行独立只读代码审查。审查范围或重点：${@:-自动检测当前暂存区或工作区变更}
