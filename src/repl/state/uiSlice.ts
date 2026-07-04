// uiSlice — focused pane, modal stack, theme, notifications (D-H2.029).
// Modal stack is LIFO; per-modal props are stored in a parallel Map keyed by
// the modal name so callers can push a confirm dialog and supply onConfirm
// callbacks without prop-drilling through the modal host.

export type FocusedPane = 'input' | 'output' | 'sidePanel' | 'detailPane' | 'modal';

export interface Notification {
  readonly id: string;
  readonly kind: 'info' | 'warn' | 'error';
  readonly text: string;
  readonly ttl: number;
}

const NOTIFICATION_CAP = 3;

let _notifSeq = 0;
function nextNotifId(): string {
  _notifSeq += 1;
  return `notif_${_notifSeq}`;
}

export interface UiSlice {
  readonly focusedPane: FocusedPane;
  readonly modalStack: readonly string[];
  /** Per-modal props; key matches modalStack entry. */
  readonly modalProps: Readonly<Record<string, unknown>>;
  readonly theme: 'dark';
  readonly notifications: readonly Notification[];
  readonly setFocus: (zone: FocusedPane) => void;
  readonly pushModal: (name: string, props?: unknown) => void;
  readonly popModal: () => void;
  readonly getModalProps: (name: string) => unknown | undefined;
  readonly pushNotification: (payload: { kind: Notification['kind']; text: string; ttl: number }) => void;
  readonly dismissNotification: (id: string) => void;
}

type SetFn = (updater: (prev: { ui: UiSlice }) => { ui: UiSlice }) => void;
type GetFn = () => { ui: UiSlice };

export function createUiSlice(set: SetFn, get?: GetFn): UiSlice {
  return {
    focusedPane: 'input',
    modalStack: [],
    modalProps: {},
    theme: 'dark',
    notifications: [],

    setFocus(zone: FocusedPane) {
      set((prev) => ({
        ...prev,
        ui: { ...prev.ui, focusedPane: zone },
      }));
    },

    pushModal(name: string, props?: unknown) {
      set((prev) => {
        const nextStack = [...prev.ui.modalStack, name];
        const nextProps = props === undefined
          ? prev.ui.modalProps
          : { ...prev.ui.modalProps, [name]: props };
        return {
          ...prev,
          ui: { ...prev.ui, modalStack: nextStack, modalProps: nextProps },
        };
      });
    },

    popModal() {
      set((prev) => {
        if (prev.ui.modalStack.length === 0) return prev;
        const next = prev.ui.modalStack.slice(0, -1);
        const popped = prev.ui.modalStack[prev.ui.modalStack.length - 1];
        if (popped === undefined) return prev;
        // Drop props only if the same name is no longer on the stack.
        const stillPresent = next.includes(popped);
        const nextProps = stillPresent
          ? prev.ui.modalProps
          : (() => {
              const copy = { ...prev.ui.modalProps };
              delete copy[popped];
              return copy;
            })();
        return { ...prev, ui: { ...prev.ui, modalStack: next, modalProps: nextProps } };
      });
    },

    getModalProps(name: string): unknown | undefined {
      // Prefer live store; otherwise return undefined (test environments
      // sometimes call this without `get` wired).
      if (get) return get().ui.modalProps[name];
      return undefined;
    },

    pushNotification(payload: { kind: Notification['kind']; text: string; ttl: number }) {
      set((prev) => {
        const notif: Notification = { id: nextNotifId(), ...payload };
        // Cap 3 FIFO: drop oldest if over cap.
        const raw = [...prev.ui.notifications, notif];
        const next = raw.length > NOTIFICATION_CAP ? raw.slice(raw.length - NOTIFICATION_CAP) : raw;
        return { ...prev, ui: { ...prev.ui, notifications: next } };
      });
    },

    dismissNotification(id: string) {
      set((prev) => ({
        ...prev,
        ui: {
          ...prev.ui,
          notifications: prev.ui.notifications.filter((n) => n.id !== id),
        },
      }));
    },
  };
}
