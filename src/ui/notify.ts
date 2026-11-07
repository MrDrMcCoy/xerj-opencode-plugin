// Completion notices for the sidebar.
//
// The first status a TUI sees is the baseline: a corpus built before this
// session started is not news. Every later change of a completion timestamp is
// one toast, and a command that just finished can supply its own richer text.

import type { StatusSnapshot } from "../rpc.ts";

export type NoticeKind = "project" | "prjdocs" | "sysdocs";

export interface PendingNotice {
  readonly kind: NoticeKind;
  readonly message: string;
}

export interface NoticeState {
  readonly baselined: boolean;
  readonly project: number;
  readonly prjdocs: number;
  readonly sysdocs: number;
}

export const EMPTY_NOTICE_STATE: NoticeState = {
  baselined: false,
  project: 0,
  prjdocs: 0,
  sysdocs: 0,
};

export interface NoticeResult {
  readonly state: NoticeState;
  readonly notices: ReadonlyArray<{ kind: NoticeKind; message: string }>;
  /** The pending notice when no completion consumed it. */
  readonly pending: PendingNotice | null;
}

export function completionNotices(
  snapshot: StatusSnapshot,
  state: NoticeState,
  pending: PendingNotice | null,
): NoticeResult {
  const project = snapshot.index.lastRunAt ?? 0;
  const prjdocs = snapshot.docs?.prjdocs.lastRunAt ?? 0;
  const sysdocs = snapshot.docs?.sysdocs.lastRunAt ?? 0;

  if (!state.baselined) {
    return {
      state: { baselined: true, project, prjdocs, sysdocs },
      notices: [],
      pending,
    };
  }

  const notices: Array<{ kind: NoticeKind; message: string }> = [];
  let used = pending;
  const fire = (kind: NoticeKind, fallback: string): void => {
    notices.push({
      kind,
      message: used?.kind === kind ? used.message : fallback,
    });
    if (used?.kind === kind) used = null;
  };

  if (project > state.project) {
    const files = snapshot.index.lastFiles;
    const records = snapshot.index.lastRecords;
    fire(
      "project",
      `XERJ indexed · ${count(files)} files · ${count(records)} records`,
    );
  }
  if (prjdocs > state.prjdocs) {
    fire("prjdocs", `XERJ project docs · ${count(snapshot.docs.prjdocs.pages)} pages`);
  }
  if (sysdocs > state.sysdocs) {
    fire("sysdocs", `XERJ system docs · ${count(snapshot.docs.sysdocs.pages)} pages`);
  }

  return {
    state: {
      baselined: true,
      project: Math.max(state.project, project),
      prjdocs: Math.max(state.prjdocs, prjdocs),
      sysdocs: Math.max(state.sysdocs, sysdocs),
    },
    notices,
    pending: used,
  };
}

function count(value: number | null | undefined): string {
  return typeof value === "number"
    ? value.toLocaleString("en-US")
    : "?";
}
