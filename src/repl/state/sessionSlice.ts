// sessionSlice — workspace, model, permissionMode, costSession (D-H2.029).

export type PermissionMode = 'default' | 'plan-only' | 'no-cli' | 'safe-mode';

const PERMISSION_CYCLE: readonly PermissionMode[] = [
  'default',
  'plan-only',
  'no-cli',
  'safe-mode',
];

export interface SessionSlice {
  readonly workspace: string;
  readonly activeModel: string | null;
  readonly permissionMode: PermissionMode;
  readonly costSession: number;
  readonly setWorkspace: (name: string) => void;
  readonly setModel: (id: string | null) => void;
  readonly cyclePermissionMode: () => void;
  readonly addCost: (usd: number) => void;
  readonly resetSession: () => void;
}

type SetFn = (updater: (prev: { session: SessionSlice }) => { session: SessionSlice }) => void;

const SESSION_DEFAULTS = {
  workspace: 'internal',
  activeModel: null as string | null,
  permissionMode: 'default' as PermissionMode,
  costSession: 0,
};

export function createSessionSlice(set: SetFn): SessionSlice {
  return {
    ...SESSION_DEFAULTS,

    setWorkspace(name: string) {
      set((prev) => ({
        ...prev,
        session: { ...prev.session, workspace: name },
      }));
    },

    setModel(id: string | null) {
      set((prev) => ({
        ...prev,
        session: { ...prev.session, activeModel: id },
      }));
    },

    cyclePermissionMode() {
      set((prev) => {
        const idx = PERMISSION_CYCLE.indexOf(prev.session.permissionMode);
        const next = PERMISSION_CYCLE[(idx + 1) % PERMISSION_CYCLE.length];
        return { ...prev, session: { ...prev.session, permissionMode: next } };
      });
    },

    addCost(usd: number) {
      set((prev) => ({
        ...prev,
        session: { ...prev.session, costSession: prev.session.costSession + usd },
      }));
    },

    resetSession() {
      // `...prev.session` keeps the methods; SESSION_DEFAULTS only overwrites
      // the four data fields.
      set((prev) => ({
        ...prev,
        session: { ...prev.session, ...SESSION_DEFAULTS },
      }));
    },
  };
}
