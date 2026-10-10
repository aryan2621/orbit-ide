import { SigningOptions } from "../lib/ipc";

// Per-project signing choices, kept on this Mac (not in the project) like Xcode's user settings.
const key = (root: string) => `orbit.signing:${root}`;

export function loadSigning(root: string): SigningOptions {
  try {
    const raw = localStorage.getItem(key(root));
    if (raw) return { teamId: null, apiKey: null, ...JSON.parse(raw) };
  } catch {}
  return { teamId: null, apiKey: null };
}

export function saveSigning(root: string, options: SigningOptions) {
  try {
    localStorage.setItem(key(root), JSON.stringify(options));
  } catch {}
}
