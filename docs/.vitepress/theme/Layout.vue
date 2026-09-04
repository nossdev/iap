<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import { useData, useRoute } from 'vitepress';
import { watchEffect } from 'vue';
import { buildNav } from '../versions';

const route = useRoute();
const { theme } = useData();

// The global `themeConfig.nav` can only define one array, but "Guide /
// Recipes / API" must route to the pages of whichever version is being read.
// This swaps the whole nav per route, including the version-switcher trigger
// text, so the reader can see at a glance which docs they're in.
//
// The version table itself lives in ../versions.ts and is shared with
// config.ts — this assignment overwrites whatever config.ts set, so the two
// must be built from the same source or the config copy becomes dead code.
//
// Runs synchronously on setup — during SSR this assigns the right nav for
// the page being prerendered, so the emitted HTML already reflects the
// active version (no hydration flash). On client-side navigation between
// versions, the same effect re-runs and swaps the nav reactively.
watchEffect(() => {
  // biome-ignore lint/suspicious/noExplicitAny: VitePress nav typing is loose
  (theme.value as any).nav = buildNav(route.path);
});
</script>

<template>
  <DefaultTheme.Layout />
</template>
