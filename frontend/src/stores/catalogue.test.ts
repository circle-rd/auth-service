import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const { api } = vi.hoisted(() => ({
  api: {
    listMemberApplications: vi.fn(),
    listOwnerApplications: vi.fn(),
    listMemberSchemes: vi.fn(),
    listMyResources: vi.fn(),
    listAccessibleResources: vi.fn(),
  },
}));

vi.mock('@/api/resources', () => api);

import { useCatalogueStore } from './catalogue';

const LAST_APP_KEY = 'auth-service:catalogue-app';

const member = { id: 'app-1', slug: 'gine', name: 'Gine', description: null, icon: null, canCreate: false };
const owned = { id: 'app-1', slug: 'gine', name: 'Gine', description: null, icon: null };

const memory = new Map<string, string>();
vi.stubGlobal('window', {
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  },
});

beforeEach(() => {
  setActivePinia(createPinia());
  memory.clear();
  vi.clearAllMocks();
  api.listMemberApplications.mockResolvedValue({ applications: [member] });
  api.listOwnerApplications.mockResolvedValue({ apps: [owned] });
  api.listMemberSchemes.mockResolvedValue({ schemes: [] });
  api.listMyResources.mockResolvedValue({ resources: [] });
  api.listAccessibleResources.mockResolvedValue({ resources: [] });
});

describe('catalogue store', () => {
  it('exposes management only while the user owns the application', async () => {
    const store = useCatalogueStore();
    await store.loadApps();
    expect(store.byId.get('app-1')?.owner).not.toBeNull();

    api.listOwnerApplications.mockResolvedValue({ apps: [] });
    await store.loadApps(true);
    expect(store.byId.get('app-1')?.owner).toBeNull();
  });

  it('drops the cached overview and the remembered application once access is lost', async () => {
    const store = useCatalogueStore();
    await store.loadApps();
    store.rememberApp('app-1');
    await store.loadOverview('app-1');
    expect(store.overviews['app-1']).toBeDefined();

    api.listMemberApplications.mockResolvedValue({ applications: [] });
    api.listOwnerApplications.mockResolvedValue({ apps: [] });
    await store.loadApps(true);

    expect(store.overviews['app-1']).toBeUndefined();
    expect(memory.get(LAST_APP_KEY) ?? null).toBeNull();
  });

  it('reset clears every cached application and the browser memory', async () => {
    const store = useCatalogueStore();
    await store.loadApps();
    store.rememberApp('app-1');
    await store.loadOverview('app-1');

    store.reset();

    expect(store.apps).toEqual([]);
    expect(store.appsLoaded).toBe(false);
    expect(store.overviews).toEqual({});
    expect(memory.get(LAST_APP_KEY) ?? null).toBeNull();
  });
});
