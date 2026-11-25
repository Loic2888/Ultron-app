import { create } from 'zustand';

/** Whether the Ultron chat panel is open (its conversation lives in the claude store). */
export const useJarvisUi = create<{ open: boolean; toggle: () => void; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
}));
