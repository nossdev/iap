import { defineConfig } from 'vitepress';

export default defineConfig({
  title: '@nossdev/iap',
  description:
    'Thin Capacitor IAP orchestrator that pairs with Attesto for server-side receipt validation.',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  // Internal recon docs (cdv-purchase-api.md, _future/plugin-v7-api.md) are
  // engineering notes; keep them out of the public site.
  srcExclude: ['internal/**', '**/README.md'],

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#6366f1' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: '@nossdev/iap' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'In-app purchases for Capacitor 5 with server-side validation via Attesto.',
      },
    ],
    ['meta', { property: 'og:url', content: 'https://iap.nossdev.com/' }],
  ],

  themeConfig: {
    logo: '/iap-logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Recipes', link: '/recipes/vue-quasar', activeMatch: '/recipes/' },
      { text: 'API', link: '/api/', activeMatch: '/api/' },
      { text: 'Migration', link: '/migration/', activeMatch: '/migration/' },
      {
        text: 'v0.1.0',
        items: [
          { text: 'Changelog', link: 'https://github.com/nossdev/iap/blob/main/CHANGELOG.md' },
          { text: 'npm', link: 'https://www.npmjs.com/package/@nossdev/iap' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is @nossdev/iap?', link: '/guide/' },
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Configuration', link: '/guide/configuration' },
          ],
        },
        {
          text: 'Concepts',
          items: [
            { text: 'Architecture', link: '/guide/architecture' },
            { text: 'Safety guarantees', link: '/guide/safety-guarantees' },
            { text: 'Backend contract', link: '/guide/backend-contract' },
            { text: 'Events', link: '/guide/events' },
            { text: 'Error handling', link: '/guide/error-handling' },
          ],
        },
        {
          text: 'Operations',
          items: [{ text: 'Testing on sandbox', link: '/guide/testing' }],
        },
      ],
      '/recipes/': [
        {
          text: 'Frameworks',
          items: [
            { text: 'Vue + Quasar', link: '/recipes/vue-quasar' },
            { text: 'React', link: '/recipes/react' },
            { text: 'Pinia store', link: '/recipes/pinia-store' },
          ],
        },
        {
          text: 'Patterns',
          items: [{ text: 'Optimistic grant', link: '/recipes/optimistic-grant' }],
        },
      ],
      '/api/': [
        {
          text: 'Reference',
          items: [
            { text: 'Overview', link: '/api/' },
            { text: 'createIAP()', link: '/api/create-iap' },
            { text: 'IAP instance', link: '/api/iap-instance' },
            { text: 'Types', link: '/api/types' },
            { text: 'Errors', link: '/api/errors' },
            { text: 'BackendAdapter', link: '/api/backend-adapter' },
            { text: 'Events reference', link: '/api/events-reference' },
          ],
        },
      ],
      '/migration/': [
        {
          text: 'Migration',
          items: [{ text: 'v0.1 → v1.0 (Capacitor 7+)', link: '/migration/' }],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/nossdev/iap' }],

    editLink: {
      pattern: 'https://github.com/nossdev/iap/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },

    footer: {
      message:
        'Released under the MIT License. Pairs with <a href="https://attesto.nossdev.com">Attesto</a> for server-side receipt validation.',
      copyright: 'Copyright © 2026 nossdev',
    },

    outline: { level: [2, 3] },
  },
});
