import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import {
  listAccessibleResources,
  listMemberApplications,
  listMemberSchemes,
  listMyResources,
  listOwnerApplications,
  type AccessibleResource,
  type OwnerApplication,
  type Resource,
  type ResourceScheme,
} from '@/api/resources';

const LAST_APP_KEY = 'auth-service:catalogue-app';

export interface CatalogueApp {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  // Set when the user administers the application or holds an owner delegation.
  owner: OwnerApplication | null;
}

export interface AppOverview {
  schemes: ResourceScheme[];
  mine: Resource[];
  accessible: AccessibleResource[];
}

export const useCatalogueStore = defineStore('catalogue', () => {
  const apps = ref<CatalogueApp[]>([]);
  const appsLoaded = ref(false);
  const appsLoading = ref(false);
  const appsError = ref(false);
  const overviews = ref<Record<string, AppOverview>>({});
  const overviewLoading = ref(false);

  const byId = computed(() => new Map(apps.value.map((app) => [app.id, app])));

  async function loadApps(force = false): Promise<void> {
    if (appsLoading.value || (appsLoaded.value && !force)) return;
    appsLoading.value = true;
    appsError.value = false;
    try {
      const [members, owners] = await Promise.all([
        listMemberApplications(),
        listOwnerApplications(),
      ]);
      const merged = new Map<string, CatalogueApp>();
      for (const app of members.applications) {
        merged.set(app.id, { ...app, owner: null });
      }
      for (const owner of owners.apps) {
        const existing = merged.get(owner.id);
        merged.set(owner.id, {
          id: owner.id,
          slug: owner.slug,
          name: owner.name,
          description: owner.description,
          icon: owner.icon,
          ...existing,
          owner,
        });
      }
      apps.value = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
      appsLoaded.value = true;
    } catch {
      appsError.value = true;
    } finally {
      appsLoading.value = false;
    }
  }

  async function loadOverview(appId: string, force = false): Promise<void> {
    if (overviews.value[appId] && !force) return;
    overviewLoading.value = true;
    try {
      // Each source degrades on its own: a delegate who is not a member of the
      // application still gets the management area.
      const [schemes, mine, accessible] = await Promise.allSettled([
        listMemberSchemes(appId),
        listMyResources(),
        listAccessibleResources({ applicationId: appId }),
      ]);
      overviews.value = {
        ...overviews.value,
        [appId]: {
          schemes: schemes.status === 'fulfilled' ? schemes.value.schemes : [],
          mine: mine.status === 'fulfilled'
            ? mine.value.resources.filter((resource) => resource.applicationId === appId)
            : [],
          accessible: accessible.status === 'fulfilled' ? accessible.value.resources : [],
        },
      };
    } finally {
      overviewLoading.value = false;
    }
  }

  function rememberApp(appId: string): void {
    window.localStorage.setItem(LAST_APP_KEY, appId);
  }

  // The last visited application when it is still reachable, else the first one.
  function defaultAppId(): string | null {
    const remembered = window.localStorage.getItem(LAST_APP_KEY);
    if (remembered && byId.value.has(remembered)) return remembered;
    return apps.value[0]?.id ?? null;
  }

  return {
    apps,
    appsLoaded,
    appsLoading,
    appsError,
    overviews,
    overviewLoading,
    byId,
    loadApps,
    loadOverview,
    rememberApp,
    defaultAppId,
  };
});
