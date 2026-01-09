import { type PreflightErrorKind, classifyPreflightErrorKind, wrapPreflightError } from '../mcp/errorKinds.js';
import { type SearchScope, type SearchHit } from '../search/sqliteFts.js';

export type SearchByTagsWarning = {
  bundleId: string;
  kind: PreflightErrorKind;
  message: string;
};

export type SearchByTagsResult = {
  totalBundlesSearched: number;
  hits: Array<{
    bundleId: string;
    bundleName?: string;
    kind: 'doc' | 'code';
    repo: string;
    path: string;
    lineNo: number;
    snippet: string;
    uri: string;
  }>;
  warnings?: SearchByTagsWarning[];
  warningsTruncated?: boolean;
};

export async function runSearchByTags(params: {
  bundleIds: string[];
  query: string;
  tags?: string[];
  scope: SearchScope;
  limit: number;
  maxWarnings?: number;
  readManifestForBundleId: (bundleId: string) => Promise<{ displayName?: string; tags?: string[] }>;
  searchIndexForBundleId: (bundleId: string, query: string, scope: SearchScope, limit: number) => SearchHit[];
  toUri: (bundleId: string, path: string) => string;
}): Promise<SearchByTagsResult> {
  const maxWarnings = params.maxWarnings ?? 20;
  const warnings: SearchByTagsWarning[] = [];
  let warningsTruncated = false;

  const pushWarning = (bundleId: string, err: unknown) => {
    if (warnings.length >= maxWarnings) {
      warningsTruncated = true;
      return;
    }
    warnings.push({
      bundleId,
      kind: classifyPreflightErrorKind(err),
      message: wrapPreflightError(err).message,
    });
  };

  // Filter bundles by tags if specified.
  const targetBundleIds: string[] = [];
  const manifestCache = new Map<string, { displayName?: string; tags?: string[] }>();

  for (const bundleId of params.bundleIds) {
    if (!params.tags || params.tags.length === 0) {
      targetBundleIds.push(bundleId);
      continue;
    }

    try {
      const manifest = await params.readManifestForBundleId(bundleId);
      manifestCache.set(bundleId, manifest);
      const tags = manifest.tags ?? [];
      if (params.tags.some((t) => tags.includes(t))) {
        targetBundleIds.push(bundleId);
      }
    } catch (err) {
      pushWarning(bundleId, err);
      // Skip bundle if we can't read tags.
    }
  }

  const hits: SearchByTagsResult['hits'] = [];

  for (const bundleId of targetBundleIds) {
    let manifest = manifestCache.get(bundleId);
    if (!manifest) {
      try {
        manifest = await params.readManifestForBundleId(bundleId);
        manifestCache.set(bundleId, manifest);
      } catch (err) {
        pushWarning(bundleId, err);
        continue;
      }
    }

    try {
      const bundleHits = params.searchIndexForBundleId(bundleId, params.query, params.scope, params.limit);
      for (const hit of bundleHits) {
        hits.push({
          bundleId,
          bundleName: manifest.displayName,
          kind: hit.kind,
          repo: hit.repo,
          path: hit.path,
          lineNo: hit.lineNo,
          snippet: hit.snippet,
          uri: params.toUri(bundleId, hit.path),
        });
        if (hits.length >= params.limit) break;
      }
    } catch (err) {
      pushWarning(bundleId, err);
    }

    if (hits.length >= params.limit) break;
  }

  return {
    totalBundlesSearched: targetBundleIds.length,
    hits: hits.slice(0, params.limit),
    warnings: warnings.length ? warnings : undefined,
    warningsTruncated: warningsTruncated ? true : undefined,
  };
}
