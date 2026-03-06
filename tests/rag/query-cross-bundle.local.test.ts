import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRetrieve = jest.fn();
const mockHierarchicalRetrieve = jest.fn();
const mockSetFilter = jest.fn();
const mockComplete = jest.fn();

jest.unstable_mockModule('../../src/rag/retriever.js', () => ({
  RAGRetriever: jest.fn().mockImplementation(() => ({
    retrieve: mockRetrieve,
  })),
}));

jest.unstable_mockModule('../../src/rag/hierarchical-retriever.js', () => ({
  HierarchicalRetriever: jest.fn().mockImplementation(() => ({
    retrieve: mockHierarchicalRetrieve,
  })),
}));

jest.unstable_mockModule('../../src/rag/context-completer.js', () => ({
  ContextCompleter: jest.fn().mockImplementation(() => ({
    setFilter: mockSetFilter,
    complete: mockComplete,
  })),
}));

const { RAGEngine } = await import('../../src/rag/query.js');

function makeChunk(id: string, bundleId: string, paperId: string) {
  return {
    id,
    content: `content for ${paperId}`,
    metadata: {
      sourceType: 'pdf_text',
      bundleId,
      paperId,
      repoId: `repo-${paperId}`,
      filePath: `${paperId}.md`,
      chunkIndex: 0,
      chunkType: 'text',
      pageIndex: 3,
      sectionHeading: 'Abstract',
    },
    score: 0.9,
  };
}

describe('RAGEngine cross-bundle query (local)', () => {
  beforeEach(() => {
    mockRetrieve.mockReset();
    mockHierarchicalRetrieve.mockReset();
    mockSetFilter.mockReset();
    mockComplete.mockReset();
  });

  function createEngine() {
    return new RAGEngine({
      chromaUrl: 'http://example.test',
      embedding: {
        embed: async () => ({ vector: [0.1, 0.2] }),
        embedBatch: async () => [{ vector: [0.1, 0.2] }],
      },
    });
  }

  it('uses single-bundle filter by default and preserves source metadata', async () => {
    mockRetrieve.mockResolvedValue({
      chunks: [makeChunk('chunk-a', 'bundle-a', 'arxiv:single')],
    });

    const engine = createEngine();
    const result = await engine.query('single question', {
      bundleId: 'bundle-a',
      mode: 'naive',
      topK: 5,
      enableContextCompletion: false,
    });

    expect(mockRetrieve).toHaveBeenCalledWith(
      'single question',
      'naive',
      5,
      { bundleId: 'bundle-a', repoId: undefined },
      expect.objectContaining({
        expandToParent: false,
        expandToSiblings: false,
      })
    );
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toEqual(
      expect.objectContaining({
        bundleId: 'bundle-a',
        paperId: 'arxiv:single',
        pageIndex: 3,
        sectionHeading: 'Abstract',
      })
    );
  });

  it('uses specified bundleIds filter for multi-bundle retrieval', async () => {
    mockRetrieve.mockResolvedValue({
      chunks: [
        makeChunk('chunk-a', 'bundle-a', 'arxiv:a'),
        makeChunk('chunk-b', 'bundle-b', 'arxiv:b'),
      ],
    });

    const engine = createEngine();
    const result = await engine.query('compare papers', {
      crossBundleMode: 'specified',
      bundleIds: ['bundle-a', 'bundle-b'],
      mode: 'naive',
      topK: 8,
      enableContextCompletion: false,
    });

    expect(mockRetrieve).toHaveBeenCalledWith(
      'compare papers',
      'naive',
      8,
      { bundleIds: ['bundle-a', 'bundle-b'], repoId: undefined },
      expect.any(Object)
    );
    expect(new Set(result.sources.map((source) => source.bundleId))).toEqual(
      new Set(['bundle-a', 'bundle-b'])
    );
  });

  it('uses hierarchical retrieval automatically for crossBundleMode=all', async () => {
    mockHierarchicalRetrieve.mockResolvedValue({
      chunks: [makeChunk('chunk-all', 'bundle-z', 'arxiv:z')],
      paperIds: ['arxiv:z'],
      stats: {
        l1ByType: { pdf: 1 },
        l1TotalFound: 1,
        l2l3ChunksFound: 1,
        durationMs: 12,
      },
    });

    const engine = createEngine();
    const result = await engine.query('all bundles question', {
      crossBundleMode: 'all',
      mode: 'naive',
      topK: 6,
      enableContextCompletion: false,
    });

    expect(mockHierarchicalRetrieve).toHaveBeenCalledWith(
      'all bundles question',
      expect.objectContaining({
        l1TopK: 10,
        l2l3TopK: 15,
      })
    );
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(result.sources).toHaveLength(1);
    expect(result.stats.hierarchicalStats).toEqual(
      expect.objectContaining({
        l1TotalFound: 1,
        l2l3ChunksFound: 1,
      })
    );
  });
});
