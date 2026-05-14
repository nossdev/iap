<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import { useData, useRoute } from 'vitepress';
import { watchEffect } from 'vue';

const route = useRoute();
const { theme } = useData();

/**
 * Build a top-nav array scoped to a given version. The same version-switcher
 * dropdown (Version + Resources sections) is appended to both so users can
 * always jump between versions. "Migration" always links to the canonical
 * page on the latest line (the v7 docs own the 5→7 guide).
 *
 * The dropdown's text changes to reflect the active version so the user can
 * see at a glance which docs they're reading.
 */
function buildNav(isV5: boolean) {
  const versionDropdown = {
    text: isV5 ? 'v5' : 'next',
    items: [
      {
        text: 'Version',
        items: [
          { text: 'next (v7)', link: '/' },
          { text: 'v5 (Capacitor 5)', link: '/v5/' },
        ],
      },
      {
        text: 'Resources',
        items: [
          {
            text: 'Changelog',
            link: 'https://github.com/nossdev/iap/blob/main/CHANGELOG.md',
          },
          { text: 'npm', link: 'https://www.npmjs.com/package/@nosslabs/iap' },
        ],
      },
    ],
  };

  const prefix = isV5 ? '/v5' : '';
  return [
    {
      text: 'Guide',
      link: `${prefix}/guide/getting-started`,
      activeMatch: `${prefix}/guide/`,
    },
    {
      text: 'Recipes',
      link: `${prefix}/recipes/vue-quasar`,
      activeMatch: `${prefix}/recipes/`,
    },
    { text: 'API', link: `${prefix}/api/`, activeMatch: `${prefix}/api/` },
    { text: 'Migration', link: '/migration/', activeMatch: '/migration/' },
    versionDropdown,
  ];
}

// Runs synchronously on setup — during SSR this assigns the right nav for
// the page being prerendered, so the emitted HTML already reflects the
// active version (no hydration flash). On client-side navigation between
// versions, the same effect re-runs and swaps the nav reactively.
watchEffect(() => {
  // biome-ignore lint/suspicious/noExplicitAny: VitePress nav typing is loose
  (theme.value as any).nav = buildNav(route.path.startsWith('/v5/'));
});
</script>

<template>
  <DefaultTheme.Layout />
</template>
