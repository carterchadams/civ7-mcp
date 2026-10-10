// Stable bootstrap for the civ7-agent development mod.
//
// Loaded once per UI realm by the game's own mod loader (UIScripts in the modinfo). It owns exactly
// one service reference and a tiny diagnostic surface, and it is the part we try never to edit
// during a development cycle: the frequently edited code lives in ./service/, loaded through a
// versioned URL so a staged build gets a fresh module identity (see docs/step-0-results.md, DEV-03).
//
// Nothing here reads opponent state, mutates the game, or accepts code or URLs from anyone.

const BUILD_ID = "__BUILD_ID__";           // stamped by `dev build`
const HERE = import.meta.url;              // fs://game/<mod>/ui/bootstrap.js, recorded for DEV-01
const TAG = "[civ7-agent]";

if (globalThis.Civ7Agent) {
  // DEV-01: a second initialization in the same realm is refused, never a second service.
  console.warn(`${TAG} bootstrap ${BUILD_ID}: already initialized by ${globalThis.Civ7Agent.status().buildId}; refusing a second instance`);
} else {
  const state = {
    buildId: BUILD_ID,
    incarnation: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    service: null,
    serviceUrl: null,
    loads: 0,
    disposals: 0,
    errors: [],
    createdAt: new Date().toISOString(),
  };

  async function dispose() {
    const s = state.service;
    state.service = null;
    state.serviceUrl = null;
    if (s) {
      await s.dispose();
      state.disposals += 1;
    }
  }

  // Load (or replace) the service from a versioned URL. `buildId` selects the module identity only;
  // the bytes come from whatever build is staged at ./service/ on disk.
  async function load(buildId = BUILD_ID) {
    await dispose();
    const url = new URL(`./service/service.js?b=${encodeURIComponent(buildId)}`, HERE).href;
    const mod = await import(url);
    const svc = await mod.start({ bootstrapBuildId: BUILD_ID, incarnation: state.incarnation, url });
    state.service = svc;
    state.serviceUrl = url;
    state.loads += 1;
    console.log(`${TAG} service loaded from ${url}`);
    return svc.status();
  }

  function status() {
    return {
      buildId: BUILD_ID,
      incarnation: state.incarnation,
      bootstrapUrl: HERE,
      createdAt: state.createdAt,
      loads: state.loads,
      disposals: state.disposals,
      serviceUrl: state.serviceUrl,
      service: state.service ? state.service.status() : null,
      errors: state.errors.slice(-5),
    };
  }

  globalThis.Civ7Agent = Object.freeze({ status, load, dispose });
  console.log(`${TAG} bootstrap ${BUILD_ID} incarnation ${state.incarnation} at ${HERE}`);
  load().catch((e) => {
    state.errors.push(`${new Date().toISOString()} initial load: ${e && e.message ? e.message : e}`);
    console.error(`${TAG} initial service load failed`, e);
  });
}
