import { reactive } from 'vue';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string
  type: ToastType
  message: string
  duration?: number
}

const toasts = reactive<Toast[]>([]);

export function useToast() {
  function add(type: ToastType, message: string, duration = 4000) {
    const id = Math.random().toString(36).slice(2);
    toasts.push({ id, type, message, duration });
    if (duration > 0) {
      setTimeout(() => remove(id), duration);
    }
  }

  function remove(id: string) {
    const idx = toasts.findIndex(t => t.id === id);
    if (idx >= 0) toasts.splice(idx, 1);
  }

  return {
    toasts,
    success: (msg: string) => add('success', msg),
    error: (msg: string) => add('error', msg),
    warning: (msg: string) => add('warning', msg),
    info: (msg: string) => add('info', msg),
    remove,
  };
}
