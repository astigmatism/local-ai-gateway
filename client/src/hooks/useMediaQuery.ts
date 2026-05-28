import { useEffect, useState } from 'react';

const supportsMatchMedia = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

export const useMediaQuery = (query: string, defaultValue = false) => {
  const [matches, setMatches] = useState(() => (supportsMatchMedia() ? window.matchMedia(query).matches : defaultValue));

  useEffect(() => {
    if (!supportsMatchMedia()) {
      setMatches(defaultValue);
      return undefined;
    }

    const mediaQueryList = window.matchMedia(query);
    const updateMatches = () => setMatches(mediaQueryList.matches);

    updateMatches();
    mediaQueryList.addEventListener('change', updateMatches);

    return () => mediaQueryList.removeEventListener('change', updateMatches);
  }, [defaultValue, query]);

  return matches;
};
