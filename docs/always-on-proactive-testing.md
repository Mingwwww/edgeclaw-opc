# AlwaysOn Proactive Testing Guide

This guide explains how to test AlwaysOn proactive discovery. The feature is not a
single button click. It is a small distributed system: browser or TUI clients write
presence, a daemon checks gates on a timer, and a target client receives a fire
request only when the user appears idle.

## Mental Model

There are two heartbeat-like systems. Keep them separate when debugging.

| System | Storage | Purpose | Owner | TTL |
| --- | --- | --- | --- | --- |
| AlwaysOn heartbeat | `<project>/.claude/always-on/heartbeats/*.beat` | Decides whether discovery may fire | Web UI / TUI writes, scheduler reads | 90s by default |
| Cron daemon client lease | Cron daemon socket RPC | Decides whether the daemon should stay alive | Web UI / TUI registers, daemon owns state | 30s by default |

The AlwaysOn heartbeat answers: "Is there an idle client I can notify?"

The client lease answers: "Is anyone still using this daemon, or should it stop?"

These are intentionally independent. A fresh client lease does not mean discovery
should fire. A fresh AlwaysOn heartbeat does not mean the daemon should live forever.

## Discovery Flow

```text
Web UI / TUI
  writes <project>/.claude/always-on/heartbeats/*.beat
  registers project with cron daemon

Cron daemon DiscoveryScheduler
  ticks per project
  reads config
  evaluates gates
  writes ~/.claude/cron-daemon/discovery-requests/{id}.json
  marks discovery-state.json as started

Web UI discovery-trigger-client
  polls discovery-requests
  finds matching WebSocket client
  sends always-on-auto-discovery-start
```

## What To Test

Test this feature in layers. Do not start with a real browser. That hides the bug
behind timing, WebSocket state, and process lifetime.

1. **Pure gates**: pass fake time and fake heartbeat files into
   `evaluateDiscoveryGates()`. This tests business rules.
2. **State files**: use a temporary project directory and assert exact JSON state.
3. **Scheduler side effects**: start `DiscoveryScheduler.ensureProject()` with a
   short tick interval and assert a request file appears.
4. **Stop races**: call `stop()` while async work is in flight and assert no fire
   request is written after stop.
5. **Client adapters**: unit test Web UI heartbeat writing separately from daemon
   scheduling.
6. **End-to-end smoke**: only after the layers above pass, start daemon + UI and
   verify the real files and socket behavior.

## Gate Matrix

`evaluateDiscoveryGates()` has eight blocking reasons:

| Gate | Test shape |
| --- | --- |
| `disabled` | Pass config with `enabled: false` |
| `project_missing` | Pass a path that does not exist |
| `no_fresh_heartbeat` | Empty heartbeat dir, or stale heartbeat |
| `agent_busy` | Heartbeat with `agentBusy: true` or processing sessions |
| `recent_user_msg` | Heartbeat with `lastUserMsgAt` within the cutoff |
| `cooldown` | State has recent `lastFireCompletedAt` |
| `daily_budget` | State has `todayRunCount >= dailyBudget` |
| `lock_busy` | Pre-create `discovery.lock` |

The pass case also matters: when both Web UI and TUI heartbeats are fresh, the
chosen heartbeat should respect `preferClient`, then newest `writtenAt` within the
same client kind.

## Five Testing Techniques

### 1. Inject Time

Bad test: sleep 5 minutes and hope the scheduler wakes up.

Good test: pass `new Date('2026-04-29T00:10:00Z')` into the function. Time becomes
data, not weather.

### 2. Use Temporary Project Roots

Always create a temp project root with `mkdtemp()`. The feature writes real files,
so tests should use the real file paths but disposable directories.

### 3. Assert Side Effects, Not Implementation

For scheduler tests, assert:

- request file exists in `cron-daemon/discovery-requests`
- `discovery-state.json` has `todayRunCount: 1`
- `discovery.lock` exists until the completion ack path releases it

Those are user-visible system effects. Private method calls are not.

### 4. Test Negative Space

Proactive features are dangerous when they fire at the wrong time. Half the test
suite should prove "nothing happens" when the user is busy, recently active, over
budget, in cooldown, or the daemon is stopping.

### 5. Race Stop Explicitly

The scheduler has multiple `if (this.stopped) return` checks because `stop()` can
happen between awaits. The test should slow down a dependency, call `stop()`, then
release the dependency and assert no fire request is written.

This catches the real bug: a daemon shutdown creating one last proactive message.
That message would feel haunted to the user. Not great.

## End-To-End Smoke

The final QA pass should verify real behavior:

1. Start the UI server.
2. Open the app and select a project.
3. Confirm a Web UI heartbeat appears under
   `<project>/.claude/always-on/heartbeats/`.
4. Confirm the cron daemon reports a fresh client lease in `ping`.
5. Enable a short test discovery config in a throwaway config dir.
6. Confirm a discovery request appears only when all gates pass.
7. Close the client and confirm the daemon stops after the empty-client delay.

Do this last. If this fails, the lower-level tests tell you where to look.
