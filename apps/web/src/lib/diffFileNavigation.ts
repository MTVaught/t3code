import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedSearchResult,
} from "@t3tools/shared/searchRanking";

export interface DiffFileNavigationEntry {
  readonly filePath: string;
}

const WIDE_DIFF_PANEL_MIN_WIDTH = 760;

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

/**
 * Filters and ranks changed files for the diff file picker. Substring hits on
 * the path rank first, then subsequence (fuzzy) matches like "dfp" → DiffPanel.
 */
export function filterDiffFiles<T extends DiffFileNavigationEntry>(
  files: ReadonlyArray<T>,
  query: string,
): T[] {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) return [...files];
  const ranked: RankedSearchResult<T>[] = [];
  for (const file of files) {
    const score = scoreQueryMatch({
      value: file.filePath.toLocaleLowerCase(),
      query: normalizedQuery,
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      fuzzyBase: 1000,
      boundaryMarkers: ["/", ".", "-", "_"],
    });
    if (score === null) continue;
    insertRankedSearchResult(
      ranked,
      { item: file, score, tieBreaker: file.filePath },
      files.length,
    );
  }
  return ranked.map((entry) => entry.item);
}
