module.exports = {
  packagerConfig: {
    asar: { unpack: "**/*.{node,mjs,wasm}" },
    appBundleId: "app.researchbunny.desktop",
    appCategoryType: "public.app-category.education",
    icon: "./assets/icon",
    ignore: [
      /^\/dist\/(integration-tests|performance|live-smoke).*$/,
      /^\/(src|tests|scripts|docs|artifacts|out)(\/|$)/,
      /^\/\..*/,
      /^\/.*\.md$/,
      /^\/tsconfig.json$/,
      /^\/eslint.config.mjs$/,
    ],
  },
  rebuildConfig: {},
  makers: [],
  plugins: [{ name: "@electron-forge/plugin-auto-unpack-natives", config: {} }],
};
