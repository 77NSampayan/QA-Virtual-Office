import { useEffect, useState } from 'react';
import { api, ApiError, type Project } from './api.ts';

const TYPES = ['general', 'web', 'api', 'mobile', 'desktop', 'automation', 'manual'];

/** Register or edit a project: a safe alias (shown everywhere) and the folder (kept locally only). */
export function ProjectForm({ initial, onDone, onCancel }: { initial?: Project; onDone: (msg: string) => void; onCancel?: () => void }) {
  const [alias, setAlias] = useState(initial?.alias ?? '');
  const [path, setPath] = useState('');
  const [type, setType] = useState(initial?.type ?? 'general');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initial) api.projectPath(initial.id).then((p) => setPath(p.pathEntered)).catch(() => setPath(''));
  }, [initial]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = initial ? await api.updateProject(initial.id, { alias, path, type }) : await api.createProject({ alias, path, type });
      const notes = [
        r.warnings.includes('alias_matches_folder_name') ? 'Warning: the alias reveals a folder name — consider a neutral alias.' : '',
        r.relinkedSessions ? `${r.relinkedSessions} earlier session(s) re-linked.` : '',
      ].filter(Boolean);
      onDone(notes.join(' ') || (initial ? 'Project updated.' : 'Project registered.'));
      if (!initial) {
        setAlias('');
        setPath('');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.code : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="project-form" onSubmit={submit}>
      <label>
        Safe alias (shown everywhere)
        <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="e.g. Payments Web" maxLength={60} required />
      </label>
      <label>
        Project folder (stored locally only, never shown in events)
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\path\to\repo" required spellCheck={false} />
      </label>
      <label>
        Type
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <div className="row">
        <button disabled={busy}>{initial ? 'Save' : 'Register project'}</button>
        {onCancel && (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
