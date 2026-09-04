import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import Layout from './Layout.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  // Custom Layout swaps the top-nav array based on which versioned-docs
  // prefix the active route falls under (see ../versions.ts) — the global nav
  // config can only define one array; this makes "Guide / Recipes / API"
  // route to the right version's pages.
  Layout,
} satisfies Theme;
