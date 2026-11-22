/** Tiny hash router (no dependency): '#/projects/proj_abc' -> '/projects/proj_abc'. */
import { useEffect, useState } from 'react';

const read = () => {
  const h = location.hash.replace(/^#/, '');
  return h.startsWith('/') ? h : '/';
};

export function useRoute(): string {
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const navigate = (to: string) => {
  location.hash = to;
};
