/** Present only when the page runs inside the Electron desktop shell (exposed by its preload). */
interface DesktopPrefs {
  minimizeToTray: boolean;
  sound: boolean;
  toastPriorities: Array<'high' | 'warning' | 'low' | 'info'>;
  startWithWindows: boolean;
}

interface Window {
  qavoDesktop?: {
    isDesktop: true;
    getPrefs: () => Promise<DesktopPrefs | null>;
    setPref: (key: keyof DesktopPrefs, value: unknown) => Promise<DesktopPrefs | null>;
    testNotification: () => Promise<boolean>;
  };
}
