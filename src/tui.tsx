// TUI part: one sidebar block and a `/xerj` command. All data comes over RPC
// from the server part, so the TUI never touches the node or the filesystem.

import { Plugin } from "@opencode/plugin/tui";
import { XerjRpc, type StatusSnapshot } from "./rpc.ts";

const POLL_MS = 5_000;

interface SidebarState {
  headline: string;
  detail: string;
  ready: boolean;
}

export default Plugin.define({
  id: "xerj.tui",
  setup(context) {
    const rpc = context.client.rpc(XerjRpc);
    const [state, update] = context.storage.memory<SidebarState>("status", {
      initial: { headline: "starting", detail: "XERJ is starting", ready: false },
    });

    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const refresh = async (): Promise<void> => {
      if (disposed || inFlight) return;
      inFlight = true;

      try {
        const snapshot = (await rpc.status({})) as StatusSnapshot;
        update((draft) => {
          draft.headline = headline(snapshot);
          draft.detail = detail(snapshot);
          draft.ready = snapshot.node?.phase === "ready";
        });
      } catch {
        update((draft) => {
          draft.headline = "offline";
          draft.detail = "the XERJ server plugin is not loaded";
          draft.ready = false;
        });
      } finally {
        inFlight = false;
      }
    };

    void refresh();
    timer = setInterval(() => void refresh(), POLL_MS);

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "xerj.status",
          title: "XERJ status",
          description: "Show the XERJ node, project index, and retrieval counters",
          group: "XERJ",
          palette: true,
          slash: { name: "xerj", arguments: true },
          run: async () => {
            await refresh();
            await context.ui.dialog.alert({
              title: "XERJ",
              message: `${state.headline}\n${state.detail}`,
            });
          },
        },
        {
          id: "xerj.reindex",
          title: "XERJ reindex",
          description: "Queue an incremental reindex of this project",
          group: "XERJ",
          palette: true,
          enabled: () => state.ready,
          run: async () => {
            try {
              const result = (await rpc.reindex({})) as { queued?: boolean };
              context.ui.toast.show({
                message: result.queued ? "XERJ reindex queued" : "XERJ indexing is disabled",
                variant: result.queued ? "success" : "info",
              });
            } catch {
              context.ui.toast.show({ message: "XERJ is not available", variant: "error" });
            }
          },
        },
      ],
    }));

    const detach = context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <box flexDirection="column">
          <text fg={context.theme.text.base}>{`XERJ  ${state.headline}`}</text>
          <text fg={context.theme.text.muted}>{state.detail}</text>
        </box>
      ),
    });

    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      detach();
    };
  },
});

function headline(snapshot: StatusSnapshot): string {
  const node = snapshot.node;
  if (!node || node.phase === "starting") return "starting";
  if (node.phase !== "ready") return node.phase === "disabled" ? "disabled" : "error";

  const docs = snapshot.index?.docs ?? 0;
  if (docs === 0) return "ready · not indexed yet";
  return `ready · ${formatCount(docs)} docs`;
}

function detail(snapshot: StatusSnapshot): string {
  const node = snapshot.node;
  if (!node || node.phase !== "ready") {
    return node?.error ?? "waiting for the node";
  }

  const version = node.serverVersion ?? "unknown";
  const index = snapshot.index;
  const state = index?.state ?? "disabled";
  const docs = index?.docs ?? 0;
  const suffix = docs > 0 ? ` · ${formatCount(docs)} docs` : "";
  return `node ${version} · ${state}${suffix}`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
