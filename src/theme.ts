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
  needle: string; amber: string; fern: string;
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

  /**
   * FULL. The only green in the app, added because a cylinder's contents are
   * the one fact a driver reads off the screen without stopping to read, and
   * there was no colour for it — full was being drawn in the brand blue, which
   * is also what "out with a customer" is drawn in.
   *
   * Measured 9.6:1 against #141B1E. That is brighter than needle (5.5) and
   * amber (7.9) on the same surface, and deliberately so: this one gets looked
   * at in July sun at arm's length, where the two warm signals have the
   * advantage of being warm and a green does not. Hue 150° keeps it clear of
   * the brand's 196° cyan, because "full" and "out" must never be a shade
   * apart. The word FULL is drawn next to it in every place it is used —
   * red/green is the worst pair there is for a colour-blind driver, and colour
   * is never the only thing carrying the state.
   */
  fern: '#3FD98B',

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

  // The same green, taken down until it survives paper: 5.4:1 on #FFFFFF,
  // which lands it between needle (5.7) and bottle (5.9) rather than shouting
  // over both. The dark palette's version measures 9.6 on its own surface, and
  // reusing it here would have measured 1.8 — the exact failure this file
  // darkens every signal colour to avoid.
  fern: '#107A42',

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
  /**
   * False until the saved preference has been read back.
   *
   * The root will not mount a screen before this is true, and that gate is the
   * whole fix for the launch flash. Reading AsyncStorage takes a few frames, so
   * the store necessarily starts on a guess — and with `key={mode}` remounting
   * the navigator, correcting that guess one frame later meant every cold start
   * on a light phone rendered dark, tore the entire tree down, and rebuilt it
   * in light. Two visible flashes and a remount, before the driver had touched
   * anything.
   */
  ready: boolean;
  setPref: (p: Pref) => void;
  setSystem: (s: 'light' | 'dark') => void;
  /** Pass what the OS reports, so pref and system resolve in one write. */
  hydrate: (system: 'light' | 'dark') => Promise<void>;
};

const resolve = (pref: Pref, system: 'light' | 'dark') =>
  pref === 'system' ? system : pref;

export const useTheme = create<S>((set, get) => ({
  pref: 'system',
  system: 'dark',
  mode: 'dark',
  ready: false,
  setPref: (pref) => {
    set({ pref, mode: resolve(pref, get().system) });
    AsyncStorage.setItem(KEY, pref).catch(() => {});
  },
  setSystem: (system) => {
    // No write, and so no remount, when the OS reports what we already had.
    // Zustand compares by reference, and `set` with an unchanged primitive
    // still notifies — which with `key={mode}` upstream is a full teardown of
    // the navigator for nothing.
    const s = get();
    const mode = resolve(s.pref, system);
    if (s.system === system && s.mode === mode) return;
    set({ system, mode });
  },
  hydrate: async (system) => {
    let pref: Pref = 'system';
    try {
      const v = await AsyncStorage.getItem(KEY);
      if (v === 'light' || v === 'dark' || v === 'system') pref = v;
    } catch { /* first run, or storage unavailable — system it is */ }
    // One write, carrying the OS value with it. Resolving these separately is
    // what produced two mode changes, and therefore two remounts, on launch.
    set({ pref, system, mode: resolve(pref, system), ready: true });
  },
}));
