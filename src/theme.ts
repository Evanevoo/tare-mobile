import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

/**
 * TWO LIGHTS.
 *
 * A phone in a yard is read at six in the morning in a shop and at two in the
 * afternoon in direct July sun, and those are not the same screen. Dark keeps
 * a driver's night vision in a cold shop; light is the only thing readable
 * outdoors at full brightness.
 *
 * The palettes carry identical keys, so every screen goes on writing T.zinc
 * and T.steel and never asks which theme it is in. `apply` mutates the shared
 * T object in place and the root remounts the tree, which is heavy but correct
 * — the alternative is threading a theme prop through forty screens for an
 * event that happens twice a year. Nothing here runs per frame.
 *
 * The two palettes are drawn for their own light rather than inverted. Dark
 * lifts a panel above the floor and catches the room on its top edge; light
 * sets a white card into warm paper and separates it with a hairline. The
 * greens darken on paper because a signal colour that fails contrast there has
 * stopped being a signal.
 */

export type Palette = {
  zinc: string; face: string; panelTop: string; panelBot: string;
  ink: string; steel: string; faint: string;
  rule: string; soft: string; edgeLit: string; stamp: string;
  bottle: string; brandLit: string; brandDark: string; onBrand: string;
  needle: string; amber: string;
  /* Not colours, but they differ: shadows have to be lighter on paper or every
     card looks like it is hovering an inch off the screen. */
  shadowInk: string;
  glow: number;              /* how much of the aurora to show, 0–1 */
  statusBar: 'light' | 'dark';
};

export const DARK: Palette = {
  zinc: '#07090A',
  face: '#141B1E',
  panelTop: '#171E21',
  panelBot: '#0D1315',

  // Contrast measured against #141B1E, the most common surface:
  // ink 13.9:1, steel 6.6:1, faint 4.7:1. All clear AA at body size.
  ink: '#EDEFEC',
  steel: '#98A4AB',
  faint: '#7C8A91',

  rule: 'rgba(255,255,255,0.085)',
  soft: 'rgba(255,255,255,0.05)',
  edgeLit: 'rgba(255,255,255,0.13)',
  stamp: '#151C1F',

  // The brand is the logo's glassy blue, and these are the console's own
  // tokens (--brand / --brand-lit / --brand-deep in marketing.css) rather than
  // a handset approximation of them. One product cannot be green on the phone
  // and blue on the web.
  bottle: '#34AEDC',
  brandLit: '#6FDDF2',
  brandDark: '#1E7CA4',
  onBrand: '#04202B',
  needle: '#F0654A',
  amber: '#E0A43A',

  shadowInk: '#000000',
  glow: 1,
  statusBar: 'light',
};

export const LIGHT: Palette = {
  // Paper, not white: a true white floor leaves white cards nothing to sit on.
  zinc: '#F3F5F1',
  face: '#FFFFFF',
  panelTop: '#FFFFFF',
  panelBot: '#F7F9F5',

  // Against #FFFFFF: ink 16.4:1, steel 6.6:1, faint 5.0:1.
  ink: '#10171A',
  steel: '#5A666C',
  faint: '#6C777D',

  rule: 'rgba(16,23,26,0.11)',
  soft: 'rgba(16,23,26,0.06)',
  edgeLit: 'rgba(255,255,255,0.95)',
  stamp: '#EDF0EA',

  // The same blue, darkened until it survives paper. Measured on #FFFFFF:
  // bottle 5.9:1, brandLit 4.6:1. brandLit has to clear 4.5 on its own because
  // it is not only the top of a gradient — it is the icon colour on the pale
  // tiles, where there is no dark surface to carry it.
  bottle: '#146C8C',
  brandLit: '#1B7FA3',
  brandDark: '#0E4E66',
  onBrand: '#F2FAFD',
  needle: '#B93A22',
  amber: '#8A5B10',

  shadowInk: '#16252B',
  glow: 0.22,                 // the aurora survives as a tint, not a light
  statusBar: 'dark',
};

export type Pref = 'system' | 'light' | 'dark';
const KEY = 'scanified.theme';

type S = {
  pref: Pref;
  /** What the OS currently reports. The root keeps this in sync. */
  system: 'light' | 'dark';
  mode: 'light' | 'dark';
  setPref: (p: Pref) => void;
  setSystem: (s: 'light' | 'dark') => void;
  hydrate: () => Promise<void>;
};

const resolve = (pref: Pref, system: 'light' | 'dark') =>
  pref === 'system' ? system : pref;

export const useTheme = create<S>((set, get) => ({
  pref: 'system',
  system: 'dark',
  mode: 'dark',
  setPref: (pref) => {
    set({ pref, mode: resolve(pref, get().system) });
    AsyncStorage.setItem(KEY, pref).catch(() => {});
  },
  setSystem: (system) => set({ system, mode: resolve(get().pref, system) }),
  hydrate: async () => {
    try {
      const v = await AsyncStorage.getItem(KEY);
      const pref: Pref = v === 'light' || v === 'dark' ? v : 'system';
      set({ pref, mode: resolve(pref, get().system) });
    } catch { /* first run, or storage unavailable — system it is */ }
  },
}));
