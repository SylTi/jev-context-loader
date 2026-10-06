# Excluded startup attempts

This directory preserves three OpenCode V2 diagnostic attempts excluded from the
[MCP discovery comparison](../../../COMPARISON.md). The native configuration uses
OpenCode's Code Mode; the proxy configuration exposes Jev search, describe and call.

These three attempts received an empty or incomplete tool catalog after MCP connection was reported ready. Initial input was 276 and 272 tokens for the proxy, versus about 600 in working runs, and 626 for native Code Mode, versus about 2,730 in working runs. The assistant transcripts also report missing tools. They are retained separately and excluded from the paired discovery comparison.

The benchmark runner waits for plugin activation and an additional one second for catalog registration before starting model inference. The three excluded attempts preceded that startup check. Their measured assistant-loop costs are separate from the paired task costs; they were rerun because the tool catalog was incomplete, regardless of task grade or routing selection.
