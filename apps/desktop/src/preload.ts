/**
 * Preload (sandboxed, context-isolated): the ONLY bridge between the web UI and the desktop shell.
 * It exposes three typed functions; the main process re-validates every call.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('qavoDesktop', {
  isDesktop: true,
  getPrefs: (): Promise<unknown> => ipcRenderer.invoke('prefs:get'),
  setPref: (key: string, value: unknown): Promise<unknown> => ipcRenderer.invoke('prefs:set', key, value),
  testNotification: (): Promise<boolean> => ipcRenderer.invoke('notify:test'),
});
