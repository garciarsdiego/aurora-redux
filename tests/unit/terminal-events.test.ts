import { describe, expect, it } from "vitest";

import {
  formatWorkflowEventForTerminal,
  terminalLinesFromDaemonEvents,
} from "@/components/terminal-events";

describe("workflow terminal event formatting", () => {
  it("formats workflow events when payload arrives as an object", () => {
    const line = formatWorkflowEventForTerminal(
      {
        type: "task_hung",
        task_id: null,
        timestamp: Date.UTC(2026, 4, 7, 21, 0, 0),
        payload: {
          task_id: "tk_1",
          heartbeat_age_ms: 107000,
          timeout_ms: 120000,
          message: "Worker stopped heartbeating before terminal state",
        },
      },
      "tk_1",
    );

    expect(line).toContain("task_hung");
    expect(line).toContain("heartbeat_age_ms");
    expect(line).toContain("timeout_ms");
  });

  it("formats workflow events when payload arrives as a JSON string", () => {
    const line = formatWorkflowEventForTerminal(
      {
        type: "task_hung",
        timestamp: Date.UTC(2026, 4, 7, 21, 0, 0),
        payload: JSON.stringify({
          task_id: "tk_2",
          last_heartbeat_at: 1778182769877,
          reason: "lease_expired",
        }),
      },
      "tk_2",
    );

    expect(line).toContain("task_hung");
    expect(line).toContain("last_heartbeat_at");
    expect(line).toContain("lease_expired");
  });

  it("ignores sibling task events", () => {
    expect(
      formatWorkflowEventForTerminal(
        {
          type: "task_started",
          task_id: "tk_other",
          timestamp: Date.UTC(2026, 4, 7, 21, 0, 0),
          payload: {},
        },
        "tk_1",
      ),
    ).toBeNull();
  });

  it("does not throw on malformed daemon payload previews", () => {
    expect(
      terminalLinesFromDaemonEvents([
        {
          id: 1,
          type: "task_review_error",
          timestamp: Date.UTC(2026, 4, 7, 21, 0, 0),
          payload_preview: '{"error":"truncated"',
        },
      ])[0],
    ).toContain("task_review_error");
  });
});
