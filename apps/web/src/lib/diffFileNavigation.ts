export interface DiffFileNavigationEntry {
  readonly filePath: string;
}

export const WIDE_DIFF_PANEL_MIN_WIDTH = 760;

export function isWideDiffPanelWidth(width: number): boolean {
  return width >= WIDE_DIFF_PANEL_MIN_WIDTH;
}

export function resolveActiveDiffFile<T extends DiffFileNavigationEntry>(
  files: ReadonlyArray<T>,
  preferredPath: string | null | undefined,
): T | undefined {
  if (preferredPath) {
    const preferred = files.find((file) => file.filePath === preferredPath);
    if (preferred) return preferred;
  }
  return files[0];
}

export function moveActiveDiffFile<T extends DiffFileNavigationEntry>(
  files: ReadonlyArray<T>,
  currentPath: string | null | undefined,
  direction: -1 | 1,
): T | undefined {
  if (files.length === 0) return undefined;
  const currentIndex = files.findIndex((file) => file.filePath === currentPath);
  if (currentIndex < 0) return files[0];
  const nextIndex = (currentIndex + direction + files.length) % files.length;
  return files[nextIndex];
}

export function filterDiffFiles<T extends DiffFileNavigationEntry>(
  files: ReadonlyArray<T>,
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...files];
  return files.filter((file) => file.filePath.toLocaleLowerCase().includes(normalizedQuery));
}
