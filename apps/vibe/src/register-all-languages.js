import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

const languageContributionModules = {
  css: () => import("monaco-editor/esm/vs/basic-languages/css/css.contribution.js"),
  html: () => import("monaco-editor/esm/vs/basic-languages/html/html.contribution.js"),
  javascript: () => import("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js"),
  markdown: () => import("monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js"),
  python: () => import("monaco-editor/esm/vs/basic-languages/python/python.contribution.js"),
  typescript: () => import("monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js"),
};

const contributionIds = Object.keys(languageContributionModules).sort();
const registeredLanguageIds = new Set(
  monaco.languages.getLanguages().map((language) => language.id),
);
const loadingLanguagePromises = new Map();

function syncBootstrapState() {
  const readyLanguageIds = contributionIds
    .filter((languageId) => registeredLanguageIds.has(languageId))
    .sort();

  window.__studioMonacoLanguageBootstrap = {
    expectedLanguageIds: contributionIds,
    registeredLanguageIds: readyLanguageIds,
    assetFiles: contributionIds.map((languageId) => `${languageId}.contribution.js`),
    hasLanguage(id) {
      return registeredLanguageIds.has(id);
    },
  };

  return readyLanguageIds;
}

async function ensureLanguageRegistered(languageId) {
  if (!languageId || registeredLanguageIds.has(languageId)) {
    return registeredLanguageIds.has(languageId);
  }

  const load = languageContributionModules[languageId];
  if (!load) {
    return false;
  }

  if (!loadingLanguagePromises.has(languageId)) {
    loadingLanguagePromises.set(
      languageId,
      load()
        .then(() => {
          registeredLanguageIds.add(languageId);
          syncBootstrapState();
          return true;
        })
        .catch((error) => {
          loadingLanguagePromises.delete(languageId);
          throw error;
        }),
    );
  }

  return loadingLanguagePromises.get(languageId);
}

function scheduleBackgroundRegistration() {
  const run = async () => {
    for (const languageId of contributionIds) {
      await ensureLanguageRegistered(languageId);
    }

    const readyLanguageIds = syncBootstrapState();
    console.info("[studio] Monaco language bootstrap ready", readyLanguageIds);
    return readyLanguageIds;
  };

  const start = () =>
    run().catch((error) => {
      console.error("[studio] Monaco language bootstrap failed", error);
      throw error;
    });

  if (typeof window.requestIdleCallback === "function") {
    return new Promise((resolve, reject) => {
      window.requestIdleCallback(() => {
        start().then(resolve).catch(reject);
      });
    });
  }

  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      start().then(resolve).catch(reject);
    }, 0);
  });
}

syncBootstrapState();
window.__studioEnsureLanguageRegistered = ensureLanguageRegistered;
window.__studioLanguageRegistrationReady = scheduleBackgroundRegistration();
